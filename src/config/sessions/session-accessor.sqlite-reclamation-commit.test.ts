import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import {
  createSqliteReclamationCommitGate,
  revokeSqliteReclamationCommit,
  withSqliteReclamationAuthorization,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type CommitOptions = {
  holdAfterApproval?: boolean;
  decisionDelayMs?: number;
  commitBudgetMs?: number;
  revokeBeforeDecision?: boolean;
  outcome?: "rollback" | "exit-before-commit";
};
function createCommitFixture(options: CommitOptions = {}) {
  const directory = fs.realpathSync(tempDirs.make("openclaw-reclamation-commit-"));
  const databasePath = path.join(directory, "proof.sqlite");
  const database = openNodeSqliteDatabase(databasePath);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES (1)",
  );
  const gate = createSqliteReclamationCommitGate();
  const progress = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`;
  const worker = new Worker(
    new URL("./session-accessor.sqlite-reclamation-commit.test-support.ts", import.meta.url),
    {
      workerData: { databasePath, gate, progress: progress.buffer, ...options },
      execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
    },
  );
  const exited = once(worker, "exit");
  const accepted = createDeferredCore();
  const release = () => {
    Atomics.store(progress, 0, 1);
    Atomics.notify(progress, 0);
  };
  const databaseOptions = { agentId: "main", path: databasePath };
  let pending: Promise<boolean> | undefined;
  return {
    database,
    gate,
    accepted: accepted.promise,
    exited,
    release,
    value: () => database.prepare("SELECT value FROM proof").get()?.value,
    nextWrite: (run: () => void) => runOpenClawAgentWriteAdmission(databaseOptions, run),
    run(assertCurrent: () => void = () => {}) {
      pending = withSqliteReclamationAuthorization(gate, database, assertCurrent, (authorize) =>
        runSqliteMutationWorkerRequest<boolean>({
          transport: { kind: "dedicated", channel: worker },
          operationId: 1,
          completion: "exit",
          dispatch: () => worker.postMessage("start", []),
          onCommitRequest: () => {
            if (options.commitBudgetMs !== undefined) {
              Atomics.store(
                new BigInt64Array(gate, 8, 1),
                0,
                process.hrtime.bigint() + BigInt(options.commitBudgetMs) * 1_000_000n,
              );
            }
            if (options.revokeBeforeDecision) {
              revokeSqliteReclamationCommit(gate);
            }
            if (options.decisionDelayMs) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.decisionDelayMs);
            }
            authorize();
            accepted.resolve();
          },
          withWriteAdmission: async (run) => {
            await runOpenClawAgentWorkerWrite(databaseOptions, run);
          },
        }),
      );
      return pending;
    },
    async [Symbol.asyncDispose]() {
      release();
      await exited;
      database.close();
      await pending?.catch(() => {});
    },
  };
}

test("serves queued work during an accepted commit while retaining writer admission", async () => {
  await using fixture = createCommitFixture({ holdAfterApproval: true, commitBudgetMs: 25 });
  let settled = false;
  const operation = fixture.run().finally(() => {
    settled = true;
  });
  const writes: number[] = [];
  await fixture.accepted;
  const queued = [1, 2].map((value) => fixture.nextWrite(() => writes.push(value)));
  await setImmediate();
  await delay(40);
  expect.soft({ settled, value: fixture.value(), writes }).toEqual({
    settled: false,
    value: 1,
    writes: [],
  });
  // Retirement refuses pending work, but cannot abandon an already accepted commit.
  revokeSqliteReclamationCommit(fixture.gate);
  fixture.release();
  await expect(operation).resolves.toBe(true);
  await Promise.all(queued);
  expect({ value: fixture.value(), writes }).toEqual({ value: 2, writes: [1, 2] });
});

test.each([
  { outcome: "rollback" as const, value: 1, exitCode: 0 },
  { outcome: "exit-before-commit" as const, value: 1, exitCode: 7 },
])(
  "joins native settlement before releasing admission ($outcome)",
  async ({ outcome, value, exitCode }) => {
    await using fixture = createCommitFixture({ outcome });
    const operation = fixture.run();
    if (exitCode) {
      await expect(operation).rejects.toThrow(`exited with code ${exitCode}`);
    } else {
      await expect(operation).resolves.toBe(true);
    }
    expect(await fixture.exited).toEqual([exitCode]);
    await fixture.nextWrite(() => {
      fixture.database.exec("BEGIN IMMEDIATE; ROLLBACK");
      expect(fixture.value()).toBe(value);
    });
  },
);

test.each(["authority", "revocation"])(
  "rolls back when %s refuses the pending commit",
  async (refusal) => {
    await using fixture = createCommitFixture();
    await expect(
      fixture.run(() => {
        if (refusal === "authority") {
          throw new Error("retired owner");
        }
        revokeSqliteReclamationCommit(fixture.gate);
      }),
    ).rejects.toThrow(refusal === "authority" ? "retired owner" : "checkpoint expired");
    expect(fixture.value()).toBe(1);
  },
);

test("refuses a current-authority decision beyond the native five-second cap", async () => {
  await using fixture = createCommitFixture({ decisionDelayMs: 6_000 });
  await expect(fixture.run()).rejects.toThrow("checkpoint expired");
  expect(fixture.value()).toBe(1);
}, 20_000);

test("refuses a parent decision after the request's remaining monotonic budget", async () => {
  await using fixture = createCommitFixture({ decisionDelayMs: 100, commitBudgetMs: 25 });
  await expect(fixture.run()).rejects.toThrow("checkpoint expired");
  expect(fixture.value()).toBe(1);
});

test("does not authorize a cancelled request within the decision budget", async () => {
  await using fixture = createCommitFixture({ decisionDelayMs: 100, revokeBeforeDecision: true });
  await expect(fixture.run()).rejects.toThrow("checkpoint expired");
  expect(fixture.value()).toBe(1);
});

test("keeps an absolute request cap through queued preparation and bounds the worker wait", () => {
  const deadline = process.hrtime.bigint() + 80_000_000n;
  const gate = createSqliteReclamationCommitGate(deadline);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  try {
    expect(() => waitForSqliteReclamationCommit(gate, () => {})).toThrow("not authorized");
    expect(Atomics.load(new BigInt64Array(gate, 8, 1), 0)).toBe(deadline);
    expect(wait.mock.calls[0]?.[3]).toBeGreaterThan(0);
    expect(wait.mock.calls[0]?.[3]).toBeLessThan(60);
  } finally {
    wait.mockRestore();
  }
});

test("refuses an already expired cap without requesting or waiting for authority", () => {
  const gate = createSqliteReclamationCommitGate(process.hrtime.bigint() - 1n);
  const request = vi.fn();
  const wait = vi.spyOn(Atomics, "wait");
  try {
    expect(() => waitForSqliteReclamationCommit(gate, request)).toThrow("deadline expired");
    expect(request).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  } finally {
    wait.mockRestore();
  }
});

test("bounds an uncapped commit decision by one five-second shared monotonic deadline", () => {
  const gate = createSqliteReclamationCommitGate();
  const before = process.hrtime.bigint();
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  try {
    expect(() => waitForSqliteReclamationCommit(gate, () => {})).toThrow("not authorized");
    const deadline = Atomics.load(new BigInt64Array(gate, 8, 1), 0);
    expect(deadline).toBeGreaterThan(before);
    expect(deadline - process.hrtime.bigint()).toBeLessThanOrEqual(5_000_000_000n);
    expect(wait.mock.calls[0]?.[3]).toBeGreaterThan(0);
    expect(wait.mock.calls[0]?.[3]).toBeLessThanOrEqual(5_000);
  } finally {
    wait.mockRestore();
  }
});
