import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import {
  CRON_MIGRATION_MAX_SNAPSHOT_BYTES,
  CRON_MIGRATION_OPERATION_ID_PATTERN,
  parseCronMigrationScope as scope,
  parseCronMigrationSnapshot,
} from "../migration-snapshot.js";
import type {
  CronMigrationRequest,
  CronMigrationResult,
  CronMigrationSnapshot,
} from "../migration.types.js";
import { isProjectedDeclaration } from "../system-owned-declaration.js";
import type { CronJob, CronStoredJob } from "../types.js";
import { materializeCronRowAgentOwners } from "./migration-owner.js";
import {
  deleteCronMigrationFence,
  listCronMigrationFences,
  listCronMigrations,
  readCronMigration,
  readCronMigrationFence,
  readCronMigrationMetadata,
  writeCronMigration,
  writeCronMigrationFence,
  type MigrationRecord,
  type MigrationStatus,
} from "./migration-persistence.js";
import {
  assertCronStoreCanPersist,
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "./row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";

type MigrationDatabase = Pick<
  DB,
  "cron_jobs" | "cron_job_scratch" | "cron_run_receipts" | "operator_approval_standing_grants"
>;
const kysely = (db: EngineConnection) => getNodeSqliteKysely<MigrationDatabase>(db);

export class CronAgentMigrationHeldError extends Error {
  constructor(
    readonly agentId: string,
    readonly operationId: string,
  ) {
    super(`Cron agent ${agentId} is held for migration ${operationId}`);
    this.name = "CronAgentMigrationHeldError";
  }
}

export function assertCronAgentMigrationAdmitted(
  db: EngineConnection,
  storeKey: string,
  agentId: string,
): void {
  const fence = readCronMigrationFence(db, storeKey, agentId);
  if (fence) {
    throw new CronAgentMigrationHeldError(agentId, fence.operation_id);
  }
}

export function assertCronJobMigrationMutationAdmitted(
  db: EngineConnection,
  storeKey: string,
  job: CronJob,
): void {
  const owner = tryResolveCronJobEffectiveAgentId(job);
  if (owner) {
    return assertCronAgentMigrationAdmitted(db, storeKey, owner);
  }
  // Retired fences stay as permanent source-side markers for the moved agents' own jobs;
  // only an in-flight migration holds jobs that no agent owns.
  const fence = listCronMigrationFences(db, storeKey).find(
    (entry) => readCronMigrationMetadata(db, storeKey, entry.operation_id)?.status !== "retired",
  );
  if (fence) {
    throw new CronAgentMigrationHeldError(fence.agent_id, fence.operation_id);
  }
}

function ownedJobs(
  db: EngineConnection,
  storeKey: string,
  agentIds: string[],
  defaultAgentId: string | undefined,
): CronStoredJob[] {
  const jobs = loadedCronStoreFromRows(loadCronRows(db, storeKey)).store.jobs;
  loadCronRuntimeAuthorities({ db, storeKey, jobs });
  const owned: CronStoredJob[] = [];
  for (const job of jobs) {
    const owner = tryResolveCronJobEffectiveAgentId(job, defaultAgentId);
    if (!owner) {
      throw new Error("Cron migration requires an explicit owner for legacy default-agent jobs");
    }
    if (agentIds.includes(owner)) {
      owned.push(tryResolveCronJobEffectiveAgentId(job) ? job : { ...job, agentId: owner });
    }
  }
  return owned;
}

function nonportableReason(job: CronStoredJob): string | undefined {
  if (!["at", "every", "cron"].includes(job.schedule.kind)) {
    return `nonportable ${job.schedule.kind} schedule`;
  }
  if (
    job.runtimeAuthority ||
    job.runtimeAuthorityRecoveryRequired ||
    job.toolsAllowExecTarget ||
    job.toolsAllowExecTargetRequirement
  ) {
    return "runtime or host-bound authority that cannot be migrated safely";
  }
  return undefined;
}

function partitionPortable(db: EngineConnection, jobs: CronStoredJob[], retainNonportable = false) {
  const grants = new Set(
    jobs.length && tableExists(db, "operator_approval_standing_grants")
      ? executeSqliteQuerySync(
          db,
          kysely(db)
            .selectFrom("operator_approval_standing_grants")
            .select("cron_job_id")
            .where(
              "cron_job_id",
              "in",
              jobs.map((job) => job.id),
            )
            .where("revoked_at_ms", "is", null),
        ).rows.map((grant) => grant.cron_job_id)
      : [],
  );
  const portable: CronStoredJob[] = [];
  const retained: CronStoredJob[] = [];
  for (const job of jobs) {
    const reason = grants.has(job.id)
      ? "host approval authority that cannot be migrated safely"
      : nonportableReason(job);
    if (reason && !retainNonportable) {
      throw new Error(`Cron job ${job.id} has ${reason}`);
    }
    (reason ? retained : portable).push(job);
  }
  return { portable, retained };
}

function projectedDeclarations(
  existing: CronStoredJob[],
  incoming: CronStoredJob[],
  defaultAgentId?: string,
) {
  const identity = (job: CronStoredJob, fallbackAgentId?: string) =>
    JSON.stringify([tryResolveCronJobEffectiveAgentId(job, fallbackAgentId), job.declarationKey]);
  const declarations = new Set(
    incoming
      .filter((job) => isProjectedDeclaration(job.declarationKey))
      .map((job) => identity(job)),
  );
  return existing.filter((job) => declarations.has(identity(job, defaultAgentId)));
}

function assertTargetJobIdsAvailable(
  db: EngineConnection,
  storeKey: string,
  incoming: CronStoredJob[],
  projected: CronStoredJob[],
  defaultAgentId?: string,
) {
  const projectedIds = new Set(
    incoming
      .filter((job) =>
        projected.some(
          (existing) =>
            existing.id === job.id &&
            existing.declarationKey === job.declarationKey &&
            tryResolveCronJobEffectiveAgentId(existing, defaultAgentId) ===
              tryResolveCronJobEffectiveAgentId(job),
        ),
      )
      .map((job) => job.id),
  );
  if (
    loadCronRows(db, storeKey, new Set(incoming.map((job) => job.id))).some(
      (row) => !projectedIds.has(row.job_id),
    )
  ) {
    throw new Error("Cron migration target job conflict");
  }
}

function persistSnapshotJobs(
  db: EngineConnection,
  storeKey: string,
  snapshot: CronMigrationSnapshot,
  jobs: CronStoredJob[],
) {
  const jobIds = new Set(jobs.map((job) => job.id));
  for (const [index, job] of snapshot.jobs.entries()) {
    if (jobIds.has(job.id)) {
      upsertCronJobRow(db, storeKey, job, index);
    }
  }
  replaceCronRuntimeAuthorityRows({ db, storeKey, jobs });
  for (const scratch of snapshot.scratch) {
    if (jobIds.has(scratch.jobId)) {
      executeSqliteQuerySync(
        db,
        kysely(db).insertInto("cron_job_scratch").values({
          store_key: storeKey,
          job_id: scratch.jobId,
          content: scratch.content,
          revision: scratch.revision,
          source_sha256: scratch.sourceSha256,
          updated_at_ms: scratch.updatedAtMs,
        }),
      );
    }
  }
}

/** Rollback attempts do not replace the preceding ownership transition. */
function retiredMigrations(
  db: EngineConnection,
  storeKey: string,
  agentIds: string[],
  operationId: string,
): Map<string, string> {
  const rows = listCronMigrations(db, storeKey).filter(
    (row) => row.operation_id !== operationId && !["aborted", "resumed"].includes(row.status),
  );
  const retired = new Map<string, string>();
  for (const row of rows) {
    // SAFETY: agent_ids_json is only ever written as JSON.stringify of a validated scope.
    for (const agentId of JSON.parse(row.agent_ids_json) as string[]) {
      if (agentIds.includes(agentId)) {
        if (row.status === "retired") {
          retired.set(agentId, row.operation_id);
        } else {
          retired.delete(agentId);
        }
      }
    }
  }
  return retired;
}

function assertDrained(
  db: EngineConnection,
  storeKey: string,
  agentIds: string[],
  jobs: CronStoredJob[],
): boolean {
  const active = tableExists(db, "cron_run_receipts")
    ? executeSqliteQueryTakeFirstSync(
        db,
        kysely(db)
          .selectFrom("cron_run_receipts")
          .select("receipt_id")
          .where("store_key", "=", storeKey)
          .where("agent_id", "in", agentIds)
          .where("status", "=", "running"),
      )
    : undefined;
  return (
    !active &&
    jobs.every(
      (job) =>
        job.state.runningAtMs === undefined &&
        job.state.queuedAtMs === undefined &&
        job.state.runningReceiptId === undefined,
    )
  );
}

function digest(snapshot: CronMigrationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function setStatus(
  db: EngineConnection,
  storeKey: string,
  operationId: string,
  status: MigrationStatus,
  snapshot?: CronMigrationSnapshot,
) {
  const row = readCronMigration(db, storeKey, operationId);
  if (!row) {
    throw new Error("Cron custody operation is missing");
  }
  writeCronMigration(db, {
    ...row,
    status,
    ...(snapshot
      ? { snapshot_json: JSON.stringify(snapshot), snapshot_digest: digest(snapshot) }
      : {}),
    ...(["activated", "resumed", "retired", "aborted"].includes(status)
      ? { snapshot_json: null }
      : {}),
  });
}
function release(
  db: EngineConnection,
  storeKey: string,
  operationId: string,
  priorRetirements?: ReadonlyMap<string, string>,
) {
  for (const fence of listCronMigrationFences(db, storeKey)) {
    if (fence.operation_id !== operationId) {
      continue;
    }
    const retirement = priorRetirements?.get(fence.agent_id);
    if (retirement) {
      writeCronMigrationFence(db, { ...fence, operation_id: retirement });
    } else {
      deleteCronMigrationFence(db, fence);
    }
  }
}
function snapshotFromRow(row: MigrationRecord): CronMigrationSnapshot {
  if (!row.snapshot_json) {
    throw new Error("Cron migration has no snapshot");
  }
  // SAFETY: snapshot_json is only ever written as JSON.stringify of a CronMigrationSnapshot by the stage phase.
  return JSON.parse(row.snapshot_json) as CronMigrationSnapshot;
}

/** Caller owns a single SQLite write transaction; no work crosses a commit boundary. */
export function executeCronMigrationInDatabase(
  db: EngineConnection,
  storeKey: string,
  request: CronMigrationRequest,
  defaultAgentId?: string,
): CronMigrationResult {
  if (!CRON_MIGRATION_OPERATION_ID_PATTERN.test(request.operationId)) {
    throw new Error("Invalid cron migration operationId");
  }
  const { operationId, phase } = request;
  const retainNonportable = request.retainNonportable === true;
  if (retainNonportable && !["hold", "export", "stage"].includes(phase)) {
    throw new Error(
      "Cron migration can retain nonportable jobs only while holding, exporting, or staging",
    );
  }
  let row = readCronMigration(db, storeKey, operationId);
  if (!row && (phase === "resume" || phase === "abort")) {
    const agentIds = request.agentIds ? scope(request.agentIds) : [];
    writeCronMigration(db, {
      store_key: storeKey,
      operation_id: operationId,
      agent_ids_json: JSON.stringify(agentIds),
      status: phase === "resume" ? "resumed" : "aborted",
      snapshot_json: null,
      snapshot_digest: null,
    });
    return { operationId, phase, agentIds, drained: true };
  }
  if (row && (row.status === "resumed" || row.status === "aborted")) {
    const terminalPhase = row.status === "resumed" ? "resume" : "abort";
    if (phase !== terminalPhase) {
      throw new Error(`Cron migration already ${row.status}`);
    }
    const agentIds = row.agent_ids_json === "[]" ? [] : scope(JSON.parse(row.agent_ids_json));
    if (
      agentIds.length &&
      request.agentIds &&
      !isDeepStrictEqual(agentIds, scope(request.agentIds))
    ) {
      throw new Error("Cron migration scope changed");
    }
    return { operationId, phase, agentIds, drained: true };
  }
  const agentIds = row ? scope(JSON.parse(row.agent_ids_json)) : scope(request.agentIds);
  if (request.agentIds && !isDeepStrictEqual(agentIds, scope(request.agentIds))) {
    throw new Error("Cron migration scope changed");
  }
  const result = (drained = true, snapshot?: CronMigrationSnapshot): CronMigrationResult => ({
    operationId,
    phase,
    agentIds,
    drained,
    ...(snapshot ? { snapshot } : {}),
  });
  if (!row) {
    if (phase !== "hold" && phase !== "stage") {
      throw new Error("Cron migration must acquire hold before this phase");
    }
    if (!retainNonportable) {
      partitionPortable(db, ownedJobs(db, storeKey, agentIds, defaultAgentId));
    }
    for (const agentId of agentIds) {
      const previous = readCronMigrationFence(db, storeKey, agentId);
      if (
        previous &&
        readCronMigrationMetadata(db, storeKey, previous.operation_id)?.status !== "retired"
      ) {
        throw new CronAgentMigrationHeldError(agentId, previous.operation_id);
      }
    }
    row = {
      store_key: storeKey,
      operation_id: operationId,
      agent_ids_json: JSON.stringify(agentIds),
      status: "held",
      snapshot_json: null,
      snapshot_digest: null,
    };
    writeCronMigration(db, row);
    for (const agentId of agentIds) {
      writeCronMigrationFence(db, {
        store_key: storeKey,
        agent_id: agentId,
        operation_id: operationId,
      });
    }
  }
  if (phase === "hold") {
    if (!["held", "exported", "staged"].includes(row.status)) {
      throw new Error(`Cron migration already ${row.status}`);
    }
    return result(
      assertDrained(db, storeKey, agentIds, ownedJobs(db, storeKey, agentIds, defaultAgentId)),
    );
  }
  if (phase === "export") {
    if (row.status === "exported") {
      return result(true, snapshotFromRow(row));
    }
    if (row.status !== "held") {
      throw new Error(`Cannot export ${row.status} cron migration`);
    }
    const owned = ownedJobs(db, storeKey, agentIds, defaultAgentId);
    const { portable: jobs, retained } = partitionPortable(db, owned, retainNonportable);
    if (!assertDrained(db, storeKey, agentIds, owned)) {
      return result(false);
    }
    const scratch = jobs.length
      ? executeSqliteQuerySync(
          db,
          kysely(db)
            .selectFrom("cron_job_scratch")
            .selectAll()
            .where("store_key", "=", storeKey)
            .where(
              "job_id",
              "in",
              jobs.map((job) => job.id),
            ),
        ).rows.map((entry) => ({
          jobId: entry.job_id,
          content: entry.content,
          revision: entry.revision,
          sourceSha256: entry.source_sha256,
          updatedAtMs: entry.updated_at_ms,
        }))
      : [];
    const snapshot: CronMigrationSnapshot = {
      version: 1,
      operationId,
      agentIds,
      jobs,
      scratch,
      ...(retainNonportable ? { retainedJobIds: retained.map((job) => job.id).toSorted() } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > CRON_MIGRATION_MAX_SNAPSHOT_BYTES) {
      throw new Error("Cron migration snapshot exceeds the 8 MiB transfer limit");
    }
    const defaultOwner = tryResolveCronJobEffectiveAgentId({}, defaultAgentId);
    if (defaultOwner && agentIds.includes(defaultOwner)) {
      materializeCronRowAgentOwners(db, storeKey, defaultOwner);
    }
    setStatus(db, storeKey, operationId, "exported", snapshot);
    return result(true, snapshot);
  }
  if (phase === "stage") {
    const snapshot = parseCronMigrationSnapshot(request.snapshot);
    if (snapshot.operationId !== operationId || !isDeepStrictEqual(snapshot.agentIds, agentIds)) {
      throw new Error("Invalid cron migration snapshot: operation or scope mismatch");
    }
    if (row.status === "staged" || row.status === "activated") {
      if (row.snapshot_digest !== digest(snapshot)) {
        throw new Error("Cron migration snapshot changed");
      }
      return result();
    }
    if (row.status !== "held") {
      throw new Error(`Cannot stage ${row.status} cron migration`);
    }
    assertCronStoreCanPersist({ version: 1, jobs: snapshot.jobs });
    partitionPortable(db, snapshot.jobs);
    if (
      snapshot.jobs.some((job) => !agentIds.includes(tryResolveCronJobEffectiveAgentId(job) ?? ""))
    ) {
      throw new Error("Cron migration snapshot contains another agent's job");
    }
    const existing = ownedJobs(db, storeKey, agentIds, defaultAgentId);
    const projected = projectedDeclarations(existing, snapshot.jobs, defaultAgentId);
    partitionPortable(db, projected);
    const projectedIds = new Set(projected.map((job) => job.id));
    assertTargetJobIdsAvailable(db, storeKey, snapshot.jobs, projected, defaultAgentId);
    const remaining = existing.filter(
      (job) => !projectedIds.has(job.id) && !isProjectedDeclaration(job.declarationKey),
    );
    if (remaining.length) {
      if (!retainNonportable) {
        throw new Error("Cron migration target job conflict");
      }
      const retired = retiredMigrations(db, storeKey, agentIds, operationId);
      for (const job of remaining) {
        if (!retired.has(tryResolveCronJobEffectiveAgentId(job, defaultAgentId) ?? "")) {
          throw new Error(
            `Cron job ${job.id} on the target was not retained by a retired migration`,
          );
        }
      }
    }
    if (!assertDrained(db, storeKey, agentIds, snapshot.jobs)) {
      throw new Error("Cron migration snapshot contains unsettled runs");
    }
    persistSnapshotJobs(
      db,
      storeKey,
      snapshot,
      snapshot.jobs.filter((job) => !isProjectedDeclaration(job.declarationKey)),
    );
    setStatus(db, storeKey, operationId, "staged", snapshot);
    return result();
  }
  if (phase === "activate") {
    if (row.status === "activated") {
      return result();
    }
    if (row.status !== "staged") {
      throw new Error(`Cannot activate ${row.status} cron migration`);
    }
    const snapshot = snapshotFromRow(row);
    const projections = snapshot.jobs.filter((job) => isProjectedDeclaration(job.declarationKey));
    const existing = loadedCronStoreFromRows(loadCronRows(db, storeKey)).store.jobs;
    const projected = projectedDeclarations(existing, projections, defaultAgentId);
    assertTargetJobIdsAvailable(db, storeKey, projections, projected, defaultAgentId);
    partitionPortable(db, projections);
    partitionPortable(db, projected);
    if (!assertDrained(db, storeKey, agentIds, projected)) {
      return result(false);
    }
    for (const job of projected) {
      deleteCronJobRowInDatabase(db, storeKey, job.id);
    }
    persistSnapshotJobs(db, storeKey, snapshot, projections);
    setStatus(db, storeKey, operationId, "activated");
    release(db, storeKey, operationId);
    return result();
  }
  if (phase === "resume") {
    if (row.status !== "held" && row.status !== "exported") {
      throw new Error(`Cannot resume ${row.status} cron migration`);
    }
    setStatus(db, storeKey, operationId, "resumed");
    release(db, storeKey, operationId, retiredMigrations(db, storeKey, agentIds, operationId));
    return result();
  }
  if (phase === "retire" || phase === "abort") {
    const next = phase === "retire" ? "retired" : "aborted";
    if (row.status === next) {
      return result();
    }
    const allowed = phase === "retire" ? ["exported"] : ["held", "staged"];
    if (!allowed.includes(row.status)) {
      throw new Error(`Cannot ${phase} ${row.status} cron migration`);
    }
    if (row.snapshot_json) {
      const snapshot = snapshotFromRow(row);
      if (
        !assertDrained(db, storeKey, agentIds, ownedJobs(db, storeKey, agentIds, defaultAgentId))
      ) {
        return result(false);
      }
      for (const job of snapshot.jobs) {
        if (phase === "abort" && isProjectedDeclaration(job.declarationKey)) {
          continue;
        }
        deleteCronJobRowInDatabase(db, storeKey, job.id);
      }
    }
    setStatus(db, storeKey, operationId, next);
    if (phase === "abort") {
      release(db, storeKey, operationId, retiredMigrations(db, storeKey, agentIds, operationId));
    }
    return result();
  }
  throw new Error("Unknown cron migration phase");
}

export function assertCronJobMigrationScratchAdmitted(
  db: EngineConnection,
  storeKey: string,
  jobId: string,
): void {
  const jobs = loadedCronStoreFromRows(loadCronRows(db, storeKey, new Set([jobId]))).store.jobs;
  const agentId = jobs[0] ? tryResolveCronJobEffectiveAgentId(jobs[0]) : undefined;
  if (!agentId) {
    return;
  }
  const fence = readCronMigrationFence(db, storeKey, agentId);
  if (fence && readCronMigrationMetadata(db, storeKey, fence.operation_id)?.status !== "held") {
    throw new CronAgentMigrationHeldError(agentId, fence.operation_id);
  }
}
