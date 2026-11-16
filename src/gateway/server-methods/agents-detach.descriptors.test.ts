import "../server-start.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runSessionRegistryMaintenance } from "../../cron/session-registry-maintenance.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

const execFileAsync = promisify(execFile);
const DELETED_SUFFIX = " (deleted)";

beforeEach(resetDatabaseEngineSelectionForTest);
afterEach(resetDatabaseEngineSelectionForTest);

async function listProcessDescriptorTargets(): Promise<string[]> {
  if (process.platform === "linux") {
    const targets: string[] = [];
    for (const name of await fs.readdir("/proc/self/fd")) {
      try {
        const target = await fs.readlink(path.join("/proc/self/fd", name));
        targets.push(
          target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target,
        );
      } catch {
        // The scan's own directory descriptor closes before it is read.
      }
    }
    return targets;
  }
  const { stdout } = await execFileAsync("lsof", ["-n", "-P", "-Fn", "-p", String(process.pid)]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

async function openDatabaseFamilyDescriptors(databasePath: string): Promise<string[]> {
  const directory = await fs.realpath(path.dirname(databasePath));
  const database = path.join(directory, path.basename(databasePath));
  const family = new Set(["", "-wal", "-shm", "-journal"].map((suffix) => `${database}${suffix}`));
  return (await listProcessDescriptorTargets()).filter((target) => family.has(target));
}

it("keeps no descriptor for a detached agent's database once session maintenance runs", async () => {
  await withOpenClawTestState(
    { label: "agent-detach-descriptors", env: deletionGatewayEnv },
    async (state) => {
      const token = "synthetic-detach-descriptor-token";
      await state.writeConfig({
        gateway: { mode: "local", auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true },
          entries: {
            keeper: { workspace: state.workspaceDir },
            traveler: { workspace: state.path("traveler-workspace") },
          },
        },
        plugins: { enabled: false },
      });
      const claim = await acquireTestPortBlock({ offsets: [0, 2] });
      const server = await startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        hotReloadRecovery: () => {
          throw new Error("Agent detach unexpectedly required a Gateway recovery restart");
        },
      });
      const client = await (async () => {
        await server.startupSettled;
        return connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: ["operator.admin"],
        });
      })();
      try {
        const key = "agent:traveler:handoff";
        await client.request("sessions.create", { agentId: "traveler", key });
        await client.request("chat.inject", { sessionKey: key, message: "Leave with the user." });
        const travelerDatabase = resolveOpenClawAgentSqlitePath({
          agentId: "traveler",
          env: state.env,
        });
        const cronStorePath = state.statePath("cron/jobs.json");

        await runSessionRegistryMaintenance({ apply: true, cronStorePath });
        // The scan must see the live agent's descriptors first, or a clean result proves nothing.
        expect(await openDatabaseFamilyDescriptors(travelerDatabase)).not.toEqual([]);

        await expect(
          client.request("agents.detach", { agentId: "traveler" }),
        ).resolves.toMatchObject({ agentId: "traveler", ok: true });
        expect(await openDatabaseFamilyDescriptors(travelerDatabase)).toEqual([]);

        await runSessionRegistryMaintenance({ apply: true, cronStorePath });

        expect(await openDatabaseFamilyDescriptors(travelerDatabase)).toEqual([]);
        await expect(fs.stat(travelerDatabase)).resolves.toBeDefined();

        await client.request("agents.create", {
          name: "traveler",
          workspace: state.path("traveler-workspace"),
        });
        await expect(client.request("chat.history", { sessionKey: key })).resolves.toMatchObject({
          messages: [expect.objectContaining({ role: "assistant" })],
        });
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
        await claim.release();
      }
    },
  );
}, 180_000);
