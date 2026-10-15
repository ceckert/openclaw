import { describe, expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  deleteCronJobScratch,
  readCronJobScratchState,
  writeCronJobScratch,
} from "../scratch-store.js";
import {
  loadCronJobsStoreWithConfigJobs,
  saveCronJobsStore,
  saveCronJobsStoreChanges,
} from "../store.js";
import type { CronStoredJob, CronStoreFile } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  assertCronAgentMigrationAdmitted,
  executeCronMigrationInDatabase,
} from "./migration.kernel.js";

function job(id: string, agentId = "alpha"): CronStoredJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

for (const mode of ["replace", "changes"] as const) {
  describe(`${mode} writes during scheduler migration`, () => {
    it("fences CRUD and both sides of owner changes while admitting unrelated jobs and runtime completion", async () => {
      await withOpenClawTestState({ label: `cron-migration-${mode}` }, async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const initial: CronStoreFile = { version: 1, jobs: [job("owned"), job("other", "beta")] };
        await saveCronJobsStore(storePath, initial);
        runOpenClawStateWriteTransaction(({ db }) =>
          executeCronMigrationInDatabase(db, cronStoreKey(storePath), {
            operationId: "migration-one",
            phase: "hold",
            agentIds: ["alpha"],
          }),
        );
        const write = async (next: CronStoreFile) => {
          if (mode === "replace") {
            await saveCronJobsStore(storePath, next);
          } else {
            await saveCronJobsStoreChanges(storePath, initial, next);
          }
        };
        const mutations: Array<(store: CronStoreFile) => void> = [
          (store) => {
            store.jobs.push(job("new"));
          },
          (store) => {
            store.jobs[0]!.name = "changed";
          },
          (store) => {
            store.jobs.shift();
          },
          (store) => {
            store.jobs[0]!.agentId = "beta";
          },
          (store) => {
            store.jobs[1]!.agentId = "alpha";
          },
          (store) => {
            const ambiguous = job("ambiguous");
            delete ambiguous.agentId;
            store.jobs.push(ambiguous);
          },
          (store) => {
            const bound = job("bound");
            delete bound.agentId;
            bound.sessionKey = "agent:alpha:main";
            store.jobs.push(bound);
          },
        ];
        for (const mutate of mutations) {
          const next = structuredClone(initial);
          mutate(next);
          await expect(write(next)).rejects.toThrow(/migration/i);
          expect(
            (await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs.map((entry) => [
              entry.id,
              entry.name,
              entry.agentId,
            ]),
          ).toEqual([
            ["owned", "owned", "alpha"],
            ["other", "other", "beta"],
          ]);
        }
        const next = structuredClone(initial);
        next.jobs[0]!.state = { lastRunAtMs: 25, lastRunStatus: "ok" };
        next.jobs[1]!.name = "unrelated update";
        await write(next);
        const saved = (await loadCronJobsStoreWithConfigJobs(storePath)).store;
        expect(saved.jobs[0]!.state).toMatchObject({ lastRunAtMs: 25, lastRunStatus: "ok" });
        expect(saved.jobs[1]!.name).toBe("unrelated update");
      });
    });
  });
}

it.each(["explicit", "default"])(
  "freezes %s-agent exported, staged, and retained scratch while allowing held run completion",
  async (owner) => {
    await withOpenClawTestState({ label: "cron-migration-scratch" }, async (state) => {
      const source = state.statePath("source", "jobs.json");
      const target = state.statePath("target", "jobs.json");
      const scratchJob = job("scratch-job");
      if (owner === "default") {
        delete scratchJob.agentId;
      }
      await saveCronJobsStore(source, {
        version: 1,
        jobs: [
          scratchJob,
          { ...scratchJob, id: "retained-job", schedule: { kind: "on-exit", command: "true" } },
        ],
      });
      const migrate = (
        storePath: string,
        phase: "hold" | "export" | "stage" | "retire",
        snapshot?: import("../migration.types.js").CronMigrationSnapshot,
      ) =>
        runOpenClawStateWriteTransaction(({ db }) =>
          executeCronMigrationInDatabase(
            db,
            cronStoreKey(storePath),
            {
              operationId: "scratch-migration",
              phase,
              agentIds: ["alpha"],
              snapshot,
              ...(phase !== "retire" ? { retainNonportable: true } : {}),
            },
            "alpha",
          ),
        );
      migrate(source, "hold");
      for (const jobId of ["scratch-job", "retained-job"]) {
        expect(
          (await writeCronJobScratch({ storePath: source, jobId, content: "completed run" })).ok,
        ).toBe(true);
      }
      const snapshot = migrate(source, "export").snapshot;
      expect(snapshot).toBeDefined();
      migrate(target, "stage", snapshot);
      const assertFrozen = async (storePath: string, jobId: string) => {
        await expect
          .soft(writeCronJobScratch({ storePath, jobId, content: "stale writer" }))
          .rejects.toThrow(/migration/i);
        expect.soft(() => deleteCronJobScratch(storePath, jobId)).toThrow(/migration/i);
        expect
          .soft(readCronJobScratchState(storePath, jobId).scratch?.content)
          .toBe("completed run");
        runOpenClawStateWriteTransaction(({ db }) => {
          expect(() =>
            assertCronAgentMigrationAdmitted(db, cronStoreKey(storePath), "alpha"),
          ).toThrow(/migration/i);
        });
      };
      for (const storePath of [source, target]) {
        await assertFrozen(storePath, "scratch-job");
      }
      await assertFrozen(source, "retained-job");
      migrate(source, "retire");
      await assertFrozen(source, "retained-job");
      const retained = (await loadCronJobsStoreWithConfigJobs(source)).store;
      expect(retained.jobs.map((entry) => entry.agentId)).toEqual(["alpha"]);
      retained.jobs[0]!.name = "stale mutation";
      await expect.soft(saveCronJobsStore(source, retained)).rejects.toThrow(/migration/i);
    });
  },
);
