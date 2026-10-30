import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../agents/agent-create.js";
import { createWorkspaceFileMutationGuard } from "../../agents/workspace-file-mutation-guard.js";
import { recordAgentDeletionRecoveryHolds } from "../../state/agent-deletion-journal-recovery.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL creation recovery checks", () => {
  const fixture = useMixedAgentPair("postgres", "postgres");

  it("rechecks creation holds without admitting caller effects or unrelated SQL", async () => {
    const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
    const assertSqlRefused = () =>
      expect(() => database.db.prepare("SELECT 1").get()).toThrow(
        "PostgreSQL connections must run in a worker",
      );
    const originalConfig = fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8");
    const stop = new Error("Stop before the persistent config write");
    let effects = 0;
    await expect(
      createAgent({
        name: "qualified",
        workspace: path.join(fixture.root, "qualified-workspace"),
        skipBootstrap: true,
        beforePersistentApply() {
          assertSqlRefused();
          if (++effects === 2) {
            throw stop;
          }
        },
      }),
    ).rejects.toBe(stop);
    expect(effects).toBe(2);
    expect(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(originalConfig);
    assertSqlRefused();

    const guard = createWorkspaceFileMutationGuard({
      assertHost: assertSqlRefused,
      recoveryHoldPredicate: { agentId: "held", held: [], applies: true },
    });
    expect(guard).toBeDefined();
    expect(() => guard!()).not.toThrow();
    const held = { agentId: "held", path: path.join(fixture.root, "held.sqlite") };
    withEngineStoreAdmission(() =>
      runSqliteImmediateTransactionSync(database.db, () =>
        recordAgentDeletionRecoveryHolds(database, [held]),
      ),
    );
    expect(() => guard!()).toThrow("has held databases");
    await expect(createAgent({ name: "held", skipBootstrap: true })).resolves.toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    assertSqlRefused();
  });
});
