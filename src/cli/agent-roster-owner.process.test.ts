import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

describe("agent roster offline ownership", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let owner: GatewayLockHandle | null;
  let claim: TestPortClaim;
  let config: string;

  beforeAll(async () => {
    root = roots.make("openclaw-agent-roster-owner-");
    env = environment(root);
    claim = await acquireTestPortBlock({ offsets: [0] });
    config = JSON.stringify({
      agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries: { main: {} } },
      gateway: { mode: "local", port: claim.port },
    });
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, config);
    openOpenClawStateDatabase({ env });
    await closeOpenClawStateDatabaseAsync();
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
  });
  afterAll(async () => {
    await owner?.release();
    await claim.release();
  });

  it.each([
    ["setup", ["setup", "--baseline", "--workspace", "WORKSPACE", "--json"]],
    [
      "advanced creation",
      ["agents", "add", "advanced", "--role", "researcher", "--workspace", "WORKSPACE", "--json"],
    ],
    [
      "team creation",
      ["agents", "team", "create", "--workspace-root", "WORKSPACE", "--non-interactive", "--json"],
    ],
    ["detach", ["agents", "detach", "traveler", "--force", "--json"]],
  ])("refuses live %s before creating state", async (name, args) => {
    const workspace = path.join(root, `uncreated-${name.replaceAll(" ", "-")}`);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, ...args.map((arg) => (arg === "WORKSPACE" ? workspace : arg))],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("exclusive offline state ownership");
    expect(result.stderr).toContain("stop the Gateway");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(config);
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the roster and workspace after the Gateway releases ownership", async () => {
    await owner?.release();
    owner = null;
    const workspace = path.join(root, "offline-workspace");
    const result = await runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "agents",
        "add",
        "offline",
        "--workspace",
        workspace,
        "--non-interactive",
        "--json",
      ],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ agentId: "offline", workspace });
    const next = await runCliProcessChild({
      nodeArgs: [...entrypoint, "agents", "list", "--json"],
      env,
    });
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toContainEqual(
      expect.objectContaining({ id: "offline", workspace }),
    );
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    await successor?.release();
  });

  it("completes offline onboarding and releases ownership for Gateway startup", async () => {
    const home = roots.make("openclaw-onboard-offline-");
    const offline = environment(home);
    const workspace = path.join(home, "workspace");
    const result = await runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--agent-name",
        "first",
        "--workspace",
        workspace,
        "--auth-choice",
        "skip",
        "--skip-skills",
        "--skip-channels",
        "--skip-ui",
        "--skip-health",
        "--json",
      ],
      env: offline,
    });
    expect(result.code, result.stderr).toBe(0);
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    const saved = JSON.parse(await fs.readFile(offline.OPENCLAW_CONFIG_PATH!, "utf8"));
    expect(saved.agents.entries.first).toBeDefined();
    const successor = await acquireGatewayLock({ env: offline, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    await successor?.release();
  });
});

it.each(["fresh", "persisted-session", "detach-retiring", "retiring", "missing-journal"] as const)(
  "recovers only an existing preserve-store detach (%s)",
  async (phase) => {
    const root = roots.make("openclaw-offline-detach-");
    const offline = createCliProcessFixture(root, environment(root));
    const agentDir = path.join(offline.env.OPENCLAW_STATE_DIR, "agents/traveler/agent");
    const workspace = path.join(offline.env.HOME, "traveler-workspace");
    const before = {
      agents: {
        ownership: "explicit",
        defaults: { skipBootstrap: true },
        entries: { keeper: {}, traveler: { workspace } },
      },
    };
    await offline.writeConfig(before);
    const database = openOpenClawStateDatabase({ env: offline.env });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const marker = path.join(workspace, "IDENTITY.md");
    await fs.writeFile(marker, "Retained traveler identity.\n");
    if (phase === "persisted-session") {
      runOpenClawAgentWriteTransaction(
        (agent) =>
          writeSessionEntry(agent, "agent:traveler:handoff", {
            sessionId: "synthetic-retained-session",
            updatedAt: 1,
          }),
        { agentId: "traveler", env: offline.env },
      );
      await closeOpenClawAgentDatabasesAsync();
    } else if (phase === "missing-journal") {
      database.db.exec("DROP TABLE agent_deletion_journal");
    } else if (phase !== "fresh") {
      beginAgentDeletionJournal(
        {
          agentId: "traveler",
          operationId: "synthetic-interrupted-detach",
          agentDir,
          workspaceDir: workspace,
          sessionsDir: path.join(offline.env.OPENCLAW_STATE_DIR, "agents/traveler/sessions"),
          phase,
          deleteFiles: false,
        },
        { env: offline.env },
      );
    }
    await closeOpenClawStateDatabaseAsync();
    const result = await offline.run(["agents", "detach", "traveler", "--force", "--json"]);
    const saved = JSON.parse(await fs.readFile(offline.configPath, "utf8"));
    expect(await fs.readFile(marker, "utf8")).toBe("Retained traveler identity.\n");
    if (phase === "fresh" || phase === "persisted-session" || phase === "detach-retiring") {
      const diagnostic = JSON.stringify({
        ...result,
        journal: readAgentDeletionJournal("traveler", { env: offline.env }),
        config: saved,
      });
      expect(result.code, diagnostic).toBe(0);
      expect(result.stdout.trim(), diagnostic).not.toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        agentId: "traveler",
        detached: true,
        storePreserved: true,
      });
      expect(saved.agents.entries.traveler).toBeUndefined();
      expect(readAgentDeletionJournal("traveler", { env: offline.env })).toMatchObject({
        phase: "detach-retiring",
        cleanupCompleted: true,
        deleteFiles: false,
      });
    } else {
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining(
            phase === "retiring" ? "finish agents.delete" : "Agent deletion journal missing",
          ),
        },
      });
      expect(saved).toEqual(before);
      if (phase === "missing-journal") {
        expect(() => readAgentDeletionJournal("traveler", { env: offline.env })).toThrow(
          "Agent deletion journal missing",
        );
      } else {
        expect(readAgentDeletionJournal("traveler", { env: offline.env })).toMatchObject({
          operationId: "synthetic-interrupted-detach",
          phase: "retiring",
          cleanupCompleted: false,
        });
      }
    }
    await closeOpenClawStateDatabaseAsync();
  },
);
