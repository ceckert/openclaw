import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { runCronMigration } from "../migration.js";
import { executeCronMigrationInDatabase } from "../store/migration.kernel.js";
import { migrateCronAgents } from "./migration.js";
import type { CronServiceState } from "./state.js";

vi.mock("../migration.js", () => ({ runCronMigration: vi.fn() }));
vi.mock("./locked.js", () => ({
  hasPendingCronSessionCleanupForAgent: () => false,
  locked: (_state: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("./store.js", () => ({ ensureLoaded: vi.fn() }));

it("holds the source before exporting for a target requester", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    vi.mocked(runCronMigration).mockImplementation(async (storePath, request) =>
      executeCronMigrationInDatabase(database, storePath, request),
    );
    const state = {
      deps: { storePath: "scheduler", storeKey: "scheduler" },
    } as CronServiceState;
    await expect(
      migrateCronAgents(state, {
        operationId: "return",
        phase: "export",
        agentIds: ["alpha"],
        retainNonportable: true,
        targetRequesterProfileId: "shared-operator",
      }),
    ).resolves.toMatchObject({
      phase: "export",
      drained: true,
      snapshot: { agentIds: ["alpha"], retainedJobIds: [] },
    });
  } finally {
    database.close();
  }
});
