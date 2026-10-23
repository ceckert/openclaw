import { AsyncLocalStorage } from "node:async_hooks";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import {
  retainSqliteWriteAdmissionService,
  withSqliteWriteAdmissionService,
} from "../../infra/sqlite-transaction.js";

const COMMIT_DECISION_TIMEOUT_NS = 10_000_000_000n;
const DEADLINE_OFFSET = BigInt64Array.BYTES_PER_ELEMENT;
const WAITING = 0;
const REJECTED = 2;
const COMMITTING = 3;
const SETTLED = 4;
const REQUESTED = 5;

export function createSqliteReclamationCommitGate(deadlineNs?: bigint): SharedArrayBuffer {
  if (deadlineNs !== undefined && (deadlineNs <= 0n || deadlineNs > 9_223_372_036_854_775_807n)) {
    throw new Error(
      "SQLite reclamation commit deadline must be a positive signed 64-bit timestamp",
    );
  }
  const buffer = new SharedArrayBuffer(DEADLINE_OFFSET + BigInt64Array.BYTES_PER_ELEMENT);
  Atomics.store(new BigInt64Array(buffer, DEADLINE_OFFSET, 1), 0, deadlineNs ?? 0n);
  return buffer;
}

/** A refused request may reuse its connection only after native rollback is confirmed. */
export class SqliteReclamationRequestRefusedError extends Error {}

/** Preserve the reclamation owner's context when an unrelated synchronous writer helps. */
export async function withSqliteReclamationAuthorization<T>(
  buffer: SharedArrayBuffer,
  database: EngineConnection | string,
  assertCurrent: () => void,
  run: (authorize: () => void) => Promise<T>,
): Promise<T> {
  const shared = new Int32Array(buffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let consumed = false;
  let failure: { error: unknown } | undefined;
  const authorize = () => {
    if (failure) {
      throw failure.error;
    }
    if (consumed) {
      return;
    }
    consumed = true;
    try {
      inOwnerContext(() => {
        assertCurrent();
        const deadline = Atomics.load(new BigInt64Array(buffer, DEADLINE_OFFSET, 1), 0);
        if (deadline <= process.hrtime.bigint()) {
          throw new Error("SQLite session reclamation commit checkpoint expired");
        }
        // Acceptance is the commit edge. Pending revocation wins this race;
        // accepted work keeps its writer permit and lifetime through native settlement.
        if (Atomics.compareExchange(shared, 0, REQUESTED, COMMITTING) !== REQUESTED) {
          throw new Error("SQLite session reclamation commit checkpoint expired");
        }
        Atomics.notify(shared, 0);
      });
    } catch (error) {
      failure = { error };
      rejectCommit(shared);
      throw error;
    }
  };
  const service = () => {
    if (Atomics.load(shared, 0) === REQUESTED) {
      try {
        authorize();
      } catch {
        // Rejection belongs to reclamation; its queued request propagates the error.
      }
    }
  };
  if (typeof database !== "string") {
    return await withSqliteWriteAdmissionService(sqlPublicationAnchor(database), service, () =>
      run(authorize),
    );
  }
  // The execution owner's admitted native location does not require a host connection.
  const release = retainSqliteWriteAdmissionService([database], service);
  try {
    return await run(authorize);
  } finally {
    release();
  }
}

function rejectCommit(shared: Int32Array): void {
  Atomics.compareExchange(shared, 0, WAITING, REJECTED);
  Atomics.compareExchange(shared, 0, REQUESTED, REJECTED);
  Atomics.notify(shared, 0);
}

/** Revoke a pending request before a synchronous native close can wait on its writer lock. */
export function revokeSqliteReclamationCommit(buffer: SharedArrayBuffer): void {
  rejectCommit(new Int32Array(buffer));
}

/** Called by the Worker while its deletion transaction still owns the writer lock. */
export function waitForSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  request: () => void,
): void {
  const shared = new Int32Array(buffer);
  const clock = new BigInt64Array(buffer, DEADLINE_OFFSET, 1);
  const cap = Atomics.load(clock, 0);
  const budget = process.hrtime.bigint() + COMMIT_DECISION_TIMEOUT_NS;
  const deadline = cap > 0n && cap < budget ? cap : budget;
  Atomics.store(clock, 0, deadline);
  if (deadline <= process.hrtime.bigint()) {
    rejectCommit(shared);
    throw new SqliteReclamationRequestRefusedError(
      "SQLite session reclamation commit deadline expired",
    );
  }
  if (Atomics.compareExchange(shared, 0, WAITING, REQUESTED) !== WAITING) {
    throw new SqliteReclamationRequestRefusedError("SQLite session reclamation commit was revoked");
  }
  request();
  Atomics.wait(
    shared,
    0,
    REQUESTED,
    Math.max(0, Number(deadline - process.hrtime.bigint()) / 1_000_000),
  );
  if (Atomics.load(shared, 0) !== COMMITTING) {
    rejectCommit(shared);
    throw new SqliteReclamationRequestRefusedError(
      "SQLite session reclamation commit was not authorized",
    );
  }
}

/** Publish only after the transaction ended or its connection successfully closed. */
export function markSqliteReclamationSettled(buffer: SharedArrayBuffer | undefined): void {
  if (buffer) {
    const shared = new Int32Array(buffer);
    Atomics.store(shared, 0, SETTLED);
    Atomics.notify(shared, 0);
  }
}
