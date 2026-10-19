import { expect, it } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronMigration } from "./migration.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

it("retains a tenant hold across worker calls and migrates without activating before cutover", async () => {
  await withOpenClawTestState({ label: "cron-migration-transfer" }, async (state) => {
    const source = state.statePath("source", "jobs.json"),
      target = state.statePath("target", "jobs.json");
    const job: CronStoredJob = {
      id: "reminder",
      agentId: "alpha",
      name: "Reminder",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check forecast" },
      state: { nextRunAtMs: 123456 },
    };
    await saveCronStore(source, { version: 1, jobs: [job] });
    await runCronMigration(source, { operationId: "transfer", phase: "hold", agentIds: ["alpha"] });
    const exported = await runCronMigration(source, { operationId: "transfer", phase: "export" });
    expect(exported.drained).toBe(true);
    await runCronMigration(target, {
      operationId: "transfer",
      phase: "stage",
      agentIds: ["alpha"],
      snapshot: exported.snapshot,
    });
    await closeOpenClawStateDatabaseAsync();
    await expect(saveCronStore(target, { version: 1, jobs: [] })).rejects.toThrow(/migration/);
    await runCronMigration(source, { operationId: "transfer", phase: "retire" });
    await runCronMigration(target, { operationId: "transfer", phase: "activate" });
    expect((await loadCronStore(source)).jobs).toEqual([]);
    expect((await loadCronStore(target)).jobs).toEqual(exported.snapshot?.jobs);
    await expect(
      runCronMigration(source, { operationId: "transfer", phase: "resume" }),
    ).rejects.toThrow(/retired/);
  });
});

it("preserves a committed hold after losing its worker reply without replaying the mutation", async () => {
  await withOpenClawTestState({ label: "cron-custody-lost-reply" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [] });
    const reply = loseFirstCronMutationReply("cron.migration");
    try {
      await expect(
        runCronMigration(storePath, {
          operationId: "lost-hold",
          phase: "hold",
          agentIds: ["alpha"],
        }),
      ).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual(["cron.migration"]);
    } finally {
      await reply.close();
    }
    await expect(
      saveCronStore(storePath, {
        version: 1,
        jobs: [
          {
            id: "late",
            agentId: "alpha",
            name: "late",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "synthetic" },
            state: {},
          },
        ],
      }),
    ).rejects.toThrow(/migration/);
    await runCronMigration(storePath, { operationId: "lost-hold", phase: "resume" });
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
  });
});
