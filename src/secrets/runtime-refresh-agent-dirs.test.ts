import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { clearSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

function roster(extra: string[]) {
  return asConfig({
    agents: { list: [{ id: "main", default: true }, ...extra.map((id) => ({ id }))] },
  });
}

describe("secrets runtime refresh agent dirs", () => {
  it("does not read a removed agent's auth store when the removal is written", async () => {
    const {
      activateSecretsRuntimeSnapshot,
      preflightActiveSecretsRuntimeSnapshotRefresh,
      refreshActiveSecretsRuntimeSnapshotForConfig,
    } = await import("./runtime.js");
    const stateDir = path.join("/tmp", "openclaw-secrets-refresh-agent-dirs");
    const removedAgentDir = path.join(stateDir, "agents", "departed", "agent");
    const readDirs: Array<string | undefined> = [];
    const loadAuthStore = (agentDir?: string): AuthProfileStore => {
      readDirs.push(agentDir);
      return { version: 1, profiles: {} };
    };
    const withDeparted = roster(["departed"]);
    const withoutDeparted = roster([]);
    activateSecretsRuntimeSnapshot(
      await prepareSecretsRuntimeSnapshot({
        config: withDeparted,
        env: { OPENCLAW_STATE_DIR: stateDir },
        loadAuthStore,
        loadablePluginOrigins: new Map(),
      }),
    );
    await expect(
      refreshActiveSecretsRuntimeSnapshotForConfig({ sourceConfig: withDeparted }),
    ).resolves.toBe(true);
    expect(readDirs).toContain(removedAgentDir);

    readDirs.length = 0;
    await preflightActiveSecretsRuntimeSnapshotRefresh({ sourceConfig: withoutDeparted });

    expect(readDirs.length).toBeGreaterThan(0);
    expect(readDirs).not.toContain(removedAgentDir);
  });
});
