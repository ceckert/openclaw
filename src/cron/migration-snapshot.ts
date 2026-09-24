import type { CronMigrationSnapshot } from "./migration.types.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import type { CronStoredJob } from "./types.js";

export const CRON_MIGRATION_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
export const CRON_MIGRATION_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const CRON_MIGRATION_MAX_AGENTS = 256;
export const CRON_MIGRATION_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCRATCH_BYTES = 262144;
const SNAPSHOT_KEYS = new Set([
  "version",
  "operationId",
  "agentIds",
  "jobs",
  "scratch",
  "retainedJobIds",
]);
const SCRATCH_KEYS = new Set(["jobId", "content", "revision", "sourceSha256", "updatedAtMs"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new Error(`Invalid cron migration snapshot: ${detail}`);
}

/** Exact, sorted, unique agent scope. */
export function parseCronMigrationScope(ids: unknown): string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > CRON_MIGRATION_MAX_AGENTS ||
    ids.some((id) => typeof id !== "string" || !CRON_MIGRATION_AGENT_ID_PATTERN.test(id))
  ) {
    throw new Error("Cron migration requires an exact nonempty agentIds scope");
  }
  // SAFETY: the guard above rejected any element that is not a string.
  const unique = [...new Set(ids as string[])].toSorted();
  if (unique.length !== ids.length) {
    throw new Error("Cron migration scope contains duplicate agents");
  }
  return unique;
}

function parseJobs(value: unknown): CronStoredJob[] {
  if (!Array.isArray(value)) {
    invalid("jobs must be an array");
  }
  const ids = new Set<string>();
  for (const job of value) {
    if (!isPlainObject(job)) {
      invalid("each job must be an object");
    }
    const reason = getInvalidPersistedCronJobReason(job);
    if (reason) {
      invalid(`job ${String(job.id)} is not persistable (${reason})`);
    }
    const id = job.id;
    if (typeof id !== "string" || ids.has(id)) {
      invalid("job IDs must be unique strings");
    }
    ids.add(id);
  }
  // SAFETY: every element passed the persisted cron job shape check above.
  return value as CronStoredJob[];
}

function parseScratch(value: unknown, jobIds: Set<string>): CronMigrationSnapshot["scratch"] {
  if (!Array.isArray(value)) {
    invalid("scratch must be an array");
  }
  const seen = new Set<string>();
  const entries: CronMigrationSnapshot["scratch"] = [];
  for (const scratch of value) {
    if (!isPlainObject(scratch) || Object.keys(scratch).some((key) => !SCRATCH_KEYS.has(key))) {
      invalid("scratch entries carry only jobId, content, revision, sourceSha256, updatedAtMs");
    }
    const { jobId, content, revision, sourceSha256, updatedAtMs } = scratch;
    if (typeof jobId !== "string" || seen.has(jobId) || !jobIds.has(jobId)) {
      invalid("scratch must reference a distinct snapshot job");
    }
    if (
      (content !== null &&
        (typeof content !== "string" || Buffer.byteLength(content) > MAX_SCRATCH_BYTES)) ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof updatedAtMs !== "number" ||
      !Number.isSafeInteger(updatedAtMs) ||
      updatedAtMs < 0 ||
      (sourceSha256 !== null &&
        (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256)))
    ) {
      invalid(`scratch for ${jobId} has an invalid field`);
    }
    seen.add(jobId);
    entries.push({ jobId, content, revision, sourceSha256, updatedAtMs });
  }
  return entries;
}

function parseRetainedJobIds(value: unknown, jobIds: Set<string>): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !id.trim() || jobIds.has(id)) ||
    new Set(value).size !== value.length
  ) {
    invalid("retainedJobIds must be unique job IDs absent from jobs");
  }
  // SAFETY: every element was checked to be a nonempty string above.
  return [...(value as string[])].toSorted();
}

/** Structural validation for a snapshot received over the wire or read back from storage. */
export function parseCronMigrationSnapshot(value: unknown): CronMigrationSnapshot {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !SNAPSHOT_KEYS.has(key))) {
    invalid("unknown or missing fields");
  }
  if (value.version !== 1) {
    invalid("unsupported version");
  }
  if (
    typeof value.operationId !== "string" ||
    !CRON_MIGRATION_OPERATION_ID_PATTERN.test(value.operationId)
  ) {
    invalid("operationId");
  }
  const agentIds = parseCronMigrationScope(value.agentIds);
  const jobs = parseJobs(value.jobs);
  const jobIds = new Set(jobs.map((job) => job.id));
  const scratch = parseScratch(value.scratch, jobIds);
  const retainedJobIds = parseRetainedJobIds(value.retainedJobIds, jobIds);
  const snapshot: CronMigrationSnapshot = {
    version: 1,
    operationId: value.operationId,
    agentIds,
    jobs,
    scratch,
    ...(retainedJobIds ? { retainedJobIds } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > CRON_MIGRATION_MAX_SNAPSHOT_BYTES) {
    invalid("exceeds the 8 MiB transfer limit");
  }
  return snapshot;
}
