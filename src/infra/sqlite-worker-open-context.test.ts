import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureAgentDatabaseAdmission,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import {
  appendWorkerRow as append,
  readWorkerRows as read,
  useSqliteWorkerStoreFixture,
} from "./sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 16,
}));

const { databasePath, tempDirs } = useSqliteWorkerStoreFixture("sqlite-open-context-");
const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;

poolIt.each([false, true])(
  "retains pending startup authority across a queued native open (revoked: %s)",
  async (revoke) => {
    const broker = new SqliteWorkerBroker();
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("sqlite-open-context-state-") };
    const pathname = databasePath();
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "preparing",
      paths: [pathname],
      pending: true,
      reason: "Agent preparing has not completed startup inspection and preparation",
    });
    const siblingRefusal = createAgentDatabaseInspectionRefusal({
      agentId: "sibling",
      paths: [],
      pending: true,
      reason: "Sibling preparation belongs to another owner",
    });
    recordAgentDatabaseAdmissions([refusal, siblingRefusal], { env, source: "startup" });
    const assertAdmitted = captureAgentDatabaseAdmission("preparing", { env });
    const assertSiblingAdmitted = captureAgentDatabaseAdmission("sibling", { env });
    const options = {
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      input: undefined,
    };
    const releaseReplies: (() => void)[] = [];
    let messages: MockInstance<Worker["emit"]> | undefined;
    let predecessor: Promise<unknown> | undefined;
    let opening: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const occupied = await Promise.all(
        Array.from({ length: 2 }, () =>
          broker.open<FixtureOperations>({ ...options, databasePath: databasePath() }),
        ),
      );
      const workers = new Set<number>();
      for (const store of occupied) {
        assert(store);
        workers.add((await append(store, "before startup")).threadId);
      }
      expect(workers.size).toBe(2);
      const held = createDeferredCore();
      messages = vi.spyOn(Worker.prototype, "emit");
      messages.mockImplementation(function (
        this: Worker,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === "message" && workers.delete(this.threadId)) {
          releaseReplies.push(() => EventEmitter.prototype.emit.call(this, event, ...args));
          if (workers.size === 0) {
            held.resolve();
          }
          return true;
        }
        return EventEmitter.prototype.emit.call(this, event, ...args);
      });
      predecessor = Promise.all(occupied.map((store) => append(store!, "queued predecessor")));
      await held.promise;
      const queued = createDeferredCore();
      const revoked = new Error("Startup preparation owner was revoked");
      let current = true;
      let opened: Awaited<ReturnType<typeof broker.open<FixtureOperations>>>;
      opening = Promise.allSettled([
        preparePendingAgentDatabase(
          refusal,
          {
            env,
            assertCurrent() {
              if (!current) {
                throw revoked;
              }
            },
          },
          async () => {
            expect(assertSiblingAdmitted).toThrow(
              expect.objectContaining({ refusal: siblingRefusal }),
            );
            opened = await broker.open<FixtureOperations>(
              { ...options, databasePath: pathname },
              undefined,
              assertAdmitted,
              {
                onNativeStopped: () => queued.resolve(),
                createAdmission: () => ({
                  nativeLocations: [pathname],
                  admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                    assertAdmitted();
                    if (!grant()) {
                      throw new Error("Queued startup open admission expired");
                    }
                  }),
                }),
              },
            );
          },
        ),
      ]);
      await queued.promise;
      expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
      current = !revoke;
      messages.mockRestore();
      for (const release of releaseReplies.splice(0)) {
        release();
      }
      await predecessor;
      const [outcome] = await opening;
      if (revoke) {
        expect(outcome).toEqual({ status: "rejected", reason: revoked });
        expect(existsSync(pathname)).toBe(false);
        expect(readAgentDatabaseAdmissionRefusal("preparing", { env })).toBe(refusal);
      } else {
        expect(outcome).toEqual({ status: "fulfilled", value: undefined });
        assert(opened);
        await append(opened, "startup converged");
        expect(await read(opened)).toEqual(["startup converged"]);
        expect(readAgentDatabaseAdmissionRefusal("preparing", { env })).toBeUndefined();
      }
      expect(readAgentDatabaseAdmissionRefusal("sibling", { env })).toBe(siblingRefusal);
    } finally {
      messages?.mockRestore();
      for (const release of releaseReplies) {
        release();
      }
      await Promise.allSettled([predecessor, opening]);
      recordAgentDatabaseAdmissions([], { env, source: "startup" });
      await broker.close();
    }
  },
);
