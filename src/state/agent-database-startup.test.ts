import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  AgentDatabasePreparationSupersededError,
  captureAgentDatabaseAdmission,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
  withAgentDatabasePreparationGuard,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { beginAgentDeletionJournal } from "./agent-deletion-journal.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";

it("settles work added during startup and retains terminal failures", async () => {
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const inspection = createDeferredCore();
    const preparation = createDeferredCore();
    const entered = createDeferredCore();
    admission.adopt();
    admission.track(
      inspection.promise.then(() => {
        admission.track(preparation.promise);
        entered.resolve();
      }),
    );
    let settled = false;
    const waiting = admission.waitForPreparation().then(() => {
      settled = true;
    });
    try {
      inspection.resolve();
      await entered.promise;
      expect(settled).toBe(false);
      preparation.reject(new Error("recorded inspection failure"));
      await waiting;
      expect(settled).toBe(true);
    } finally {
      inspection.resolve();
      preparation.resolve();
      await admission.stop();
    }
  });
});

it("rejects preparation waiters on shutdown before custody work drains", async () => {
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const work = createDeferredCore();
    admission.adopt();
    admission.track(work.promise);
    const waiting = admission.waitForPreparation();
    let drained = false;
    const stopping = admission.stop().then(() => {
      drained = true;
    });
    try {
      await expect(waiting).rejects.toThrow("Gateway stopped during agent database inspection");
      expect(drained).toBe(false);
      await expect(admission.waitForPreparation()).rejects.toThrow("Gateway stopped");
    } finally {
      work.resolve();
      await stopping;
    }
  });
});

it.for(["recover", "failure", "owner-loss", "replacement", "deletion", "shutdown"] as const)(
  "retains startup admission and FIFO custody across supersession (%s)",
  async (outcome, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const env = state.env;
      const first = openOpenClawAgentDatabase({ agentId: "first", env });
      const second = openOpenClawAgentDatabase({ agentId: "second", env });
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const work: Promise<unknown>[] = [];
        const track = admission.track.bind(admission);
        vi.spyOn(admission, "track").mockImplementation((operation) => {
          work.push(operation);
          track(operation);
        });
        admission.adopt();
        const refusals = admission.defer({
          env,
          reason: "synthetic completed inspections",
          inspections: [first, second].map((database) => ({
            target: { agentId: database.agentId, path: database.path },
            result: Promise.resolve({ incompatible: [], indeterminate: [] }),
          })),
        });
        recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const order: string[] = [];
        const escaped: Array<() => void> = [];
        let revision = 0;
        let current = true;
        const openAgent = vi.fn(async ({ agentId }: { agentId: string }) => {
          if (agentId === "second") {
            await entered.promise;
          }
        });
        admission.activate({
          isCurrent: () => current,
          openAgent,
          prepareAgent: async (input) => {
            order.push(input.agentId);
            const originalRevision = revision;
            const assertAdmitted = captureAgentDatabaseAdmission(input.agentId, { env });
            const runInScope = AsyncLocalStorage.snapshot();
            escaped.push(() => runInScope(assertAdmitted));
            await withAgentDatabasePreparationGuard(
              () => {
                input.assertCurrent();
                if (revision !== originalRevision) {
                  throw new AgentDatabasePreparationSupersededError(input.agentId);
                }
              },
              async () => {
                if (input.agentId === "first" && order.length === 1) {
                  entered.resolve();
                  await release.promise;
                  if (outcome === "failure") {
                    throw new Error("synthetic native preparation failure");
                  }
                } else if (input.agentId === "first" && order.length === 2) {
                  revision++;
                }
              },
            );
          },
        });
        try {
          await withinTest(entered.promise, signal);
          expect(order).toEqual(["first"]);
          expect(readAgentDatabaseAdmissionRefusal("first", { env })).toBe(refusals[0]);
          expect(readAgentDatabaseAdmissionRefusal("second", { env })).toBe(refusals[1]);
          revision++;
          if (outcome === "owner-loss") {
            current = false;
          } else if (outcome === "replacement") {
            const replacement = `${first.path}.replacement`;
            fs.copyFileSync(first.path, replacement);
            fs.renameSync(replacement, first.path);
          } else if (outcome === "deletion") {
            beginAgentDeletionJournal(
              {
                agentId: "first",
                operationId: "delete-first",
                agentDir: state.agentDir("first"),
                workspaceDir: state.workspaceDir,
                sessionsDir: state.sessionsDir("first"),
                deleteFiles: false,
              },
              { env },
            );
          } else if (outcome === "shutdown") {
            void admission.stop();
          }
          release.resolve();
          await withinTest(Promise.all(work), signal);
          if (outcome === "recover") {
            expect(order).toEqual(["first", "first", "first", "second"]);
            expect(readAgentDatabaseAdmissionRefusal("first", { env })).toBeUndefined();
            expect(readAgentDatabaseAdmissionRefusal("second", { env })).toBeUndefined();
          } else {
            expect(order.filter((agentId) => agentId === "first")).toHaveLength(1);
            expect(readAgentDatabaseAdmissionRefusal("first", { env })?.code).toBe(
              outcome === "shutdown"
                ? "agent-database-inspection-pending"
                : "agent-database-inspection-failed",
            );
          }
          expect(openAgent.mock.calls.filter(([input]) => input.agentId === "first")).toHaveLength(
            1,
          );
          for (const assertEscaped of escaped) {
            expect(assertEscaped).toThrow("preparation has ended");
          }
        } finally {
          release.resolve();
          await admission.stop();
          vi.restoreAllMocks();
        }
      });
    });
  },
);
