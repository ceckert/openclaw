import "../server-start.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runSessionRegistryMaintenance } from "../../cron/session-registry-maintenance.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { registerOpenClawAgentDatabaseSyncResource } from "../../state/openclaw-agent-db-resources.js";
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

const benchmark = process.env.OPENCLAW_DETACH_BENCH === "1";

it.each(benchmark ? ["serial", "batch"] : ["batch"])(
  "closes database owners and preserves history through %s detach",
  async (mode) => {
    await withOpenClawTestState(
      { label: "agent-detach-descriptors", env: deletionGatewayEnv },
      async (state) => {
        const token = "synthetic-detach-descriptor-token";
        const agentIds = benchmark
          ? ["traveler", "voyager", "wayfarer", "ranger", "nomad"]
          : ["traveler", "voyager"];
        await state.writeConfig({
          gateway: { mode: "local", auth: { mode: "token", token } },
          agents: {
            ownership: "explicit",
            defaults: { skipBootstrap: true },
            entries: {
              keeper: { workspace: state.workspaceDir },
              ...Object.fromEntries(
                agentIds.map((agentId) => [
                  agentId,
                  { workspace: state.path(`${agentId}-workspace`) },
                ]),
              ),
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
          const databasePaths = agentIds.map((agentId) =>
            resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
          );
          for (const agentId of agentIds) {
            const key = `agent:${agentId}:handoff`;
            await client.request("sessions.create", { agentId, key });
            await client.request("chat.inject", {
              sessionKey: key,
              message: "Leave with the user.",
            });
          }
          const cronStorePath = state.statePath("cron/jobs.json");

          await runSessionRegistryMaintenance({ apply: true, cronStorePath });
          for (const database of databasePaths) {
            expect(await openDatabaseFamilyDescriptors(database)).not.toEqual([]);
          }
          const detachStarted = performance.now();
          if (mode === "batch") {
            await expect(client.request("agents.detachMany", { agentIds })).resolves.toMatchObject({
              ok: true,
              results: agentIds.map((agentId) => ({ agentId, ok: true, failed: [], removed: [] })),
            });
          } else {
            for (const agentId of agentIds) {
              await expect(client.request("agents.detach", { agentId })).resolves.toMatchObject({
                ok: true,
                agentId,
                failed: [],
                removed: [],
              });
            }
          }
          const receiptMs = Math.round(performance.now() - detachStarted);
          for (const database of databasePaths) {
            expect(await openDatabaseFamilyDescriptors(database)).toEqual([]);
          }

          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: [expect.objectContaining({ id: "keeper" })],
          });
          if (benchmark) {
            console.log(
              JSON.stringify({
                mode,
                agentCount: agentIds.length,
                receiptMs,
                sourceReadyMs: Math.round(performance.now() - detachStarted),
              }),
            );
          }

          await runSessionRegistryMaintenance({ apply: true, cronStorePath });
          for (const database of databasePaths) {
            expect(await openDatabaseFamilyDescriptors(database)).toEqual([]);
            await expect(fs.stat(database)).resolves.toBeDefined();
          }
          for (const agentId of agentIds) {
            await client.request("agents.create", {
              name: agentId,
              workspace: state.path(`${agentId}-workspace`),
            });
            await expect(
              client.request("chat.history", { sessionKey: `agent:${agentId}:handoff` }),
            ).resolves.toMatchObject({
              messages: [expect.objectContaining({ role: "assistant" })],
            });
          }
        } finally {
          await disconnectGatewayClient(client);
          await server.close();
          await claim.release();
        }
      },
    );
  },
  180_000,
);

it("closes the exact retained PostgreSQL anchor when the agent is already absent", async () => {
  await withOpenClawTestState(
    { label: "agent-detach-orphan-descriptor", env: deletionGatewayEnv },
    async (state) => {
      const token = "synthetic-orphan-descriptor-token";
      await state.writeConfig({
        gateway: { mode: "local", auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true },
          entries: { keeper: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
      });
      const claim = await acquireTestPortBlock({ offsets: [0, 2] });
      const server = await startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await server.startupSettled;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${claim.port}`,
        token,
        scopes: ["operator.admin"],
      });
      const anchorPath = resolveOpenClawAgentSqlitePath({ agentId: "traveler", env: state.env });
      const keeperPath = resolveOpenClawAgentSqlitePath({ agentId: "keeper", env: state.env });
      async function openAnchor(file: string, agentId: string) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const db = new DatabaseSync(file);
        db.exec(
          "CREATE TABLE IF NOT EXISTS openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
        );
        db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
          randomUUID(),
          `retained_${agentId}`,
        );
        let closed = false;
        const close = () => {
          if (closed) {
            return;
          }
          closed = true;
          db.close();
        };
        const unregister = registerOpenClawAgentDatabaseSyncResource({
          agentId,
          path: file,
          revoke: () => {},
          close,
        });
        return () => {
          unregister();
          close();
        };
      }
      const closeTraveler = await openAnchor(anchorPath, "traveler");
      const closeKeeper = await openAnchor(keeperPath, "keeper");
      try {
        const bytes = await fs.readFile(anchorPath);
        const config = await fs.readFile(state.configPath);
        expect(await openDatabaseFamilyDescriptors(anchorPath)).not.toEqual([]);
        await expect(client.request("agents.detach", { agentId: "traveler" })).rejects.toThrow(
          "not found",
        );
        expect(await openDatabaseFamilyDescriptors(anchorPath)).toEqual([]);
        expect(await openDatabaseFamilyDescriptors(keeperPath)).not.toEqual([]);
        expect(await fs.readFile(anchorPath)).toEqual(bytes);
        expect(await fs.readFile(state.configPath)).toEqual(config);
      } finally {
        closeTraveler();
        closeKeeper();
        await disconnectGatewayClient(client);
        await server.close();
        await claim.release();
      }
    },
  );
}, 90_000);
