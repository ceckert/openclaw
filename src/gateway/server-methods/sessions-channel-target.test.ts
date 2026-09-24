import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChannelSessionTarget } from "./sessions-channel-target.js";

it("preserves configured and prior-store selection and duplicate rejection off the Gateway thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = "agent:main:mattermost:group:target";
    const configured = state.statePath("configured", "agents", "main", "sessions", "sessions.json");
    const prior = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const cfg = {
      agents: { entries: { main: {} } },
      session: {
        store: state.statePath("configured", "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await state.writeConfig(cfg);
    const read = async () => {
      const sql = observeHostDataSql(state.env);
      try {
        return await prepareChannelSessionTarget({ cfg, key, agentId: "main" });
      } finally {
        expect(sql.queries).toEqual([]);
        sql.restore();
      }
    };
    const missing = await read();
    expect(missing.storePath).toBe(configured);
    expect(missing.store[key]).toBeUndefined();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key, storePath: prior },
      { sessionId: "prior", updatedAt: 1 },
    );
    expect((await read()).store[key]?.sessionId).toBe("prior");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key, storePath: configured },
      { sessionId: "configured", updatedAt: 2 },
    );
    await expect(read()).rejects.toThrow("duplicate rows resolve to canonical session key");
  });
});
