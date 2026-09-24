import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql, type Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
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
import { isSystemMonitorDeclaration } from "../system-owned-declaration.js";
import type { CronJob, CronStoredJob } from "../types.js";
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

type MigrationStatus =
  | "held"
  | "exported"
  | "staged"
  | "activated"
  | "resumed"
  | "retired"
  | "aborted";
type MigrationTable = {
  store_key: string;
  operation_id: string;
  agent_ids_json: string;
  status: MigrationStatus;
  snapshot_json: string | null;
  snapshot_digest: string | null;
};
type FenceTable = { store_key: string; agent_id: string; operation_id: string };
type MigrationDatabase = Pick<
  DB,
  "cron_jobs" | "cron_job_scratch" | "cron_run_receipts" | "operator_approval_standing_grants"
> & {
  cron_migrations: MigrationTable;
  cron_agent_migration_fences: FenceTable;
};
const kysely = (db: DatabaseSync) => getNodeSqliteKysely<MigrationDatabase>(db);
const TABLE = "cron_migrations";

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
  db: DatabaseSync,
  storeKey: string,
  agentId: string,
): void {
  if (!tableExists(db, TABLE)) {
    return;
  }
  const fence = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("cron_agent_migration_fences")
      .select("operation_id")
      .where("store_key", "=", storeKey)
      .where("agent_id", "=", agentId),
  );
  if (fence) {
    throw new CronAgentMigrationHeldError(agentId, fence.operation_id);
  }
}

export function assertCronJobMigrationMutationAdmitted(
  db: DatabaseSync,
  storeKey: string,
  job: CronJob,
): void {
  const owner = tryResolveCronJobEffectiveAgentId(job);
  if (owner) {
    return assertCronAgentMigrationAdmitted(db, storeKey, owner);
  }
  if (!tableExists(db, TABLE)) {
    return;
  }
  const fence = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("cron_agent_migration_fences")
      .select(["agent_id", "operation_id"])
      .where("store_key", "=", storeKey),
  );
  if (fence) {
    throw new CronAgentMigrationHeldError(fence.agent_id, fence.operation_id);
  }
}

function ownedJobs(
  db: DatabaseSync,
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
  if (owned.length && tableExists(db, "operator_approval_standing_grants")) {
    const grant = executeSqliteQueryTakeFirstSync(
      db,
      kysely(db)
        .selectFrom("operator_approval_standing_grants")
        .select("cron_job_id")
        .where(
          "cron_job_id",
          "in",
          owned.map((job) => job.id),
        )
        .where("revoked_at_ms", "is", null),
    );
    if (grant) {
      throw new Error(
        `Cron job ${grant.cron_job_id} has host approval authority that cannot be migrated safely`,
      );
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

function assertPortable(jobs: CronStoredJob[]) {
  for (const job of jobs) {
    const reason = nonportableReason(job);
    if (reason) {
      throw new Error(`Cron job ${job.id} has ${reason}`);
    }
  }
}

function partitionPortable(jobs: CronStoredJob[]) {
  const portable: CronStoredJob[] = [];
  const retained: CronStoredJob[] = [];
  for (const job of jobs) {
    (nonportableReason(job) ? retained : portable).push(job);
  }
  return { portable, retained };
}

/** Agents whose most recent other migration on this store ended in retirement. */
function retiredAgents(
  db: DatabaseSync,
  storeKey: string,
  agentIds: string[],
  operationId: string,
): Set<string> {
  const rows = executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom(TABLE)
      .select(["agent_ids_json", "status", sql<number>`rowid`.as("rowid")])
      .where("store_key", "=", storeKey)
      .where("operation_id", "!=", operationId)
      .orderBy("rowid", "asc"),
  ).rows;
  const latest = new Map<string, MigrationStatus>();
  for (const row of rows) {
    // SAFETY: agent_ids_json is only ever written as JSON.stringify of a validated scope.
    for (const agentId of JSON.parse(row.agent_ids_json) as string[]) {
      if (agentIds.includes(agentId)) {
        latest.set(agentId, row.status);
      }
    }
  }
  return new Set([...latest].filter(([, status]) => status === "retired").map(([id]) => id));
}

function assertDrained(
  db: DatabaseSync,
  storeKey: string,
  agentIds: string[],
  jobs: CronStoredJob[],
): boolean {
  const active = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("cron_run_receipts")
      .select("receipt_id")
      .where("store_key", "=", storeKey)
      .where("agent_id", "in", agentIds)
      .where("status", "=", "running"),
  );
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
  db: DatabaseSync,
  storeKey: string,
  operationId: string,
  status: MigrationStatus,
  snapshot?: CronMigrationSnapshot,
) {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("cron_migrations")
      .set({
        status,
        ...(snapshot
          ? { snapshot_json: JSON.stringify(snapshot), snapshot_digest: digest(snapshot) }
          : {}),
        ...(["activated", "resumed", "retired", "aborted"].includes(status)
          ? { snapshot_json: null }
          : {}),
      })
      .where("store_key", "=", storeKey)
      .where("operation_id", "=", operationId),
  );
}
function release(db: DatabaseSync, storeKey: string, operationId: string) {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .deleteFrom("cron_agent_migration_fences")
      .where("store_key", "=", storeKey)
      .where("operation_id", "=", operationId),
  );
}
function snapshotFromRow(row: Selectable<MigrationTable>): CronMigrationSnapshot {
  if (!row.snapshot_json) {
    throw new Error("Cron migration has no snapshot");
  }
  // SAFETY: snapshot_json is only ever written as JSON.stringify of a CronMigrationSnapshot by the stage phase.
  return JSON.parse(row.snapshot_json) as CronMigrationSnapshot;
}

/** Caller owns a single SQLite write transaction; no work crosses a commit boundary. */
export function executeCronMigrationInDatabase(
  db: DatabaseSync,
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
  let row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom(TABLE)
      .selectAll()
      .where("store_key", "=", storeKey)
      .where("operation_id", "=", operationId),
  );
  if (!row && (phase === "resume" || phase === "abort")) {
    const agentIds = request.agentIds ? scope(request.agentIds) : [];
    executeSqliteQuerySync(
      db,
      kysely(db)
        .insertInto(TABLE)
        .values({
          store_key: storeKey,
          operation_id: operationId,
          agent_ids_json: JSON.stringify(agentIds),
          status: phase === "resume" ? "resumed" : "aborted",
          snapshot_json: null,
          snapshot_digest: null,
        }),
    );
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
      assertPortable(ownedJobs(db, storeKey, agentIds, defaultAgentId));
    }
    for (const agentId of agentIds) {
      const previous = executeSqliteQueryTakeFirstSync(
        db,
        kysely(db)
          .selectFrom("cron_agent_migration_fences as f")
          .innerJoin("cron_migrations as m", (join) =>
            join
              .onRef("m.store_key", "=", "f.store_key")
              .onRef("m.operation_id", "=", "f.operation_id"),
          )
          .select(["f.operation_id", "m.status"])
          .where("f.store_key", "=", storeKey)
          .where("f.agent_id", "=", agentId),
      );
      if (previous && previous.status !== "retired") {
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
    executeSqliteQuerySync(db, kysely(db).insertInto(TABLE).values(row));
    for (const agentId of agentIds) {
      executeSqliteQuerySync(
        db,
        kysely(db)
          .insertInto("cron_agent_migration_fences")
          .values({ store_key: storeKey, agent_id: agentId, operation_id: operationId })
          .onConflict((oc) =>
            oc.columns(["store_key", "agent_id"]).doUpdateSet({ operation_id: operationId }),
          ),
      );
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
    if (!retainNonportable) {
      assertPortable(owned);
    }
    if (!assertDrained(db, storeKey, agentIds, owned)) {
      return result(false);
    }
    const { portable: jobs, retained } = partitionPortable(owned);
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
    assertPortable(snapshot.jobs);
    if (
      snapshot.jobs.some((job) => !agentIds.includes(tryResolveCronJobEffectiveAgentId(job) ?? ""))
    ) {
      throw new Error("Cron migration snapshot contains another agent's job");
    }
    const existing = ownedJobs(db, storeKey, agentIds, defaultAgentId);
    const incomingMonitors = new Map(
      snapshot.jobs.flatMap((job) =>
        isSystemMonitorDeclaration(job.declarationKey) ? [[job.declarationKey!, job]] : [],
      ),
    );
    const projectedMonitors = existing.filter((job) => {
      const incoming = isSystemMonitorDeclaration(job.declarationKey)
        ? incomingMonitors.get(job.declarationKey!)
        : undefined;
      return (
        incoming !== undefined &&
        tryResolveCronJobEffectiveAgentId(incoming) ===
          tryResolveCronJobEffectiveAgentId(job, defaultAgentId)
      );
    });
    const projectedIds = new Set(projectedMonitors.map((job) => job.id));
    if (
      loadCronRows(db, storeKey, new Set(snapshot.jobs.map((job) => job.id))).some(
        (existingRow) => !projectedIds.has(existingRow.job_id),
      )
    ) {
      throw new Error("Cron migration target job conflict");
    }
    const remaining = existing.filter(
      (job) => !projectedIds.has(job.id) && !isSystemMonitorDeclaration(job.declarationKey),
    );
    if (remaining.length) {
      if (!retainNonportable) {
        throw new Error("Cron migration target job conflict");
      }
      const retired = retiredAgents(db, storeKey, agentIds, operationId);
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
    for (const job of projectedMonitors) {
      deleteCronJobRowInDatabase(db, storeKey, job.id);
    }
    for (const [index, job] of snapshot.jobs.entries()) {
      upsertCronJobRow(db, storeKey, job, index);
    }
    replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: snapshot.jobs });
    for (const scratch of snapshot.scratch) {
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
    setStatus(db, storeKey, operationId, "activated");
    release(db, storeKey, operationId);
    return result();
  }
  if (phase === "resume") {
    if (row.status !== "held" && row.status !== "exported") {
      throw new Error(`Cannot resume ${row.status} cron migration`);
    }
    setStatus(db, storeKey, operationId, "resumed");
    release(db, storeKey, operationId);
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
        deleteCronJobRowInDatabase(db, storeKey, job.id);
      }
    }
    setStatus(db, storeKey, operationId, next);
    if (phase === "abort") {
      release(db, storeKey, operationId);
    }
    return result();
  }
  throw new Error("Unknown cron migration phase");
}

export function assertCronJobMigrationScratchAdmitted(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
): void {
  if (!tableExists(db, TABLE)) {
    return;
  }
  const jobs = loadedCronStoreFromRows(loadCronRows(db, storeKey, new Set([jobId]))).store.jobs;
  const agentId = jobs[0] ? tryResolveCronJobEffectiveAgentId(jobs[0]) : undefined;
  if (!agentId) {
    return;
  }
  const fence = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("cron_agent_migration_fences as f")
      .innerJoin("cron_migrations as m", (join) =>
        join
          .onRef("m.store_key", "=", "f.store_key")
          .onRef("m.operation_id", "=", "f.operation_id"),
      )
      .select(["f.operation_id", "m.status"])
      .where("f.store_key", "=", storeKey)
      .where("f.agent_id", "=", agentId),
  );
  if (fence && fence.status !== "held") {
    throw new CronAgentMigrationHeldError(agentId, fence.operation_id);
  }
}
