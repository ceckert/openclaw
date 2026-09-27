import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerMemoryCapability } from "../plugins/memory-state.js";
import { disposePluginRegistryInstances, requireActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listOpenSqliteFamilyPaths } from "../test-utils/process-open-files.js";
import { createGatewayMemoryCloseRegistryFactory } from "./server-close.memory.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const TOKEN = "agents-delete-database-handles";
const DELETED_AGENT = { id: "alpha", name: "Alpha" };
const SURVIVOR_AGENT = { id: "beta", name: "Beta" };

type ChatEvent = { runId?: string; state?: string; errorMessage?: string };

function completedResponsesSse(text: string): string {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

// Leaving WAL needs an exclusive lock, which any connection in this process still refuses.
function leaveWalMode(databasePath: string): unknown {
  const db = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    return db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
  } finally {
    db.close();
  }
}

describe("agents.delete releases every database handle in the Gateway process", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it(
    "leaves no open descriptor for the deleted agent's database family after a shared-gateway lifecycle",
    { timeout: 240_000 },
    async () => {
      const state = await createOpenClawTestState({
        label: "delete-db-handles",
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
        },
      });
      cleanups.push(async () => {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await state.cleanup();
      });

      const providerServer = createServer((request, response) => {
        request.resume();
        request.once("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(completedResponsesSse("acknowledged"));
        });
      });
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          }),
      );
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("mock provider did not bind");
      }
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "delete-handles",
      );
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            [DELETED_AGENT, SURVIVOR_AGENT].map((agent) => [
              agent.id,
              { name: agent.name, workspace: state.path(`workspace-${agent.id}`) },
            ]),
          ),
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: TOKEN } },
      } satisfies OpenClawConfig;

      const chatEvents: ChatEvent[] = [];
      const chatWaiters = new Map<string, ReturnType<typeof createDeferred<ChatEvent>>>();
      const gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: TOKEN,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        // Roster removal is an irreversible hot reload; a managed restart owner must exist.
        hotReloadRecovery: () => ({ status: "emitted" as const }),
        onEvent: (event) => {
          if (event.event !== "chat") {
            return;
          }
          const payload = event.payload as ChatEvent;
          chatEvents.push(payload);
          if (payload.runId && (payload.state === "final" || payload.state === "error")) {
            chatWaiters.get(payload.runId)?.resolve(payload);
          }
        },
      });
      cleanups.push(async () => {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "agents delete database handles test complete" });
      });
      const { client } = gateway;

      const runTurn = async (agentId: string, label: string) => {
        const runId = `${agentId}-${label}`;
        const finished = createDeferred<ChatEvent>();
        chatWaiters.set(runId, finished);
        await expect(
          client.request("chat.send", {
            sessionKey: `agent:${agentId}:main`,
            message: `Turn ${label} for ${agentId}.`,
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
        const terminal = await finished.promise;
        expect(terminal, JSON.stringify(chatEvents.slice(-5))).toMatchObject({ state: "final" });
      };
      const refreshCatalog = async (agentId: string) => {
        await expect(
          client.request("models.list", { agentId, refresh: true }),
        ).resolves.toBeDefined();
      };
      const hotReload = async (every: string) => {
        const current = await client.request<{ hash: string }>("config.get", {});
        await expect(
          client.request("config.patch", {
            raw: JSON.stringify({ agents: { defaults: { heartbeat: { every } } } }),
            baseHash: current.hash,
          }),
        ).resolves.toMatchObject({ ok: true });
      };

      for (const agent of [DELETED_AGENT, SURVIVOR_AGENT]) {
        await expect(
          client.request("sessions.create", { agentId: agent.id, key: `agent:${agent.id}:main` }),
        ).resolves.toMatchObject({ key: `agent:${agent.id}:main` });
      }
      const deletedDatabasePath = resolveOpenClawAgentSqlitePath({
        agentId: DELETED_AGENT.id,
        env: process.env,
      });
      const survivorDatabasePath = resolveOpenClawAgentSqlitePath({
        agentId: SURVIVOR_AGENT.id,
        env: process.env,
      });

      const memoryConfig = {
        ...loadConfig(),
        memory: {
          search: {
            provider: "fixture-embedding",
            model: "synthetic-embedding",
            fallback: "none" as const,
            store: { vector: { enabled: false } },
          },
        },
      };
      const createMemory = await createGatewayMemoryCloseRegistryFactory(memoryConfig);
      const memory = createMemory(async () => {});
      const registry = requireActivePluginRegistry();
      const priorMemoryCapabilities = [...registry.memoryCapabilities];
      registerMemoryCapability("memory-fixture", { runtime: memory.runtime });
      cleanups.push(async () => {
        registry.memoryCapabilities = priorMemoryCapabilities;
        await memory.runtime.closeAllMemorySearchManagers?.();
        await disposePluginRegistryInstances(memory.registry);
      });

      for (const agent of [DELETED_AGENT, SURVIVOR_AGENT]) {
        await runTurn(agent.id, "first");
        const opened = await memory.runtime.getMemorySearchManager({
          cfg: memoryConfig,
          agentId: agent.id,
        });
        expect(opened.manager, opened.error).not.toBeNull();
        await expect(opened.manager!.probeEmbeddingAvailability()).resolves.toMatchObject({
          ok: true,
        });
        await expect(
          client.request("cron.add", {
            name: `${agent.name} daily`,
            agentId: agent.id,
            enabled: true,
            schedule: { kind: "every", everyMs: 86_400_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Check the queue." },
            delivery: { mode: "none" },
          }),
        ).resolves.toMatchObject({ agentId: agent.id, enabled: true });
      }
      await refreshCatalog(DELETED_AGENT.id);
      await refreshCatalog(SURVIVOR_AGENT.id);
      await expect(client.request("secrets.reload", {})).resolves.toBeDefined();
      await hotReload("12h");
      await sleep(2_000);
      await runTurn(DELETED_AGENT.id, "second");
      await runTurn(SURVIVOR_AGENT.id, "second");
      await refreshCatalog(DELETED_AGENT.id);
      await refreshCatalog(SURVIVOR_AGENT.id);

      // The scan must see live SQLite descriptors before deletion, or a clean result proves nothing.
      expect(await listOpenSqliteFamilyPaths(deletedDatabasePath)).not.toEqual([]);

      await expect(
        client.request("agents.delete", { agentId: DELETED_AGENT.id, deleteFiles: false }),
      ).resolves.toMatchObject({ agentId: DELETED_AGENT.id, ok: true });

      expect(await listOpenSqliteFamilyPaths(deletedDatabasePath)).toEqual([]);
      expect(leaveWalMode(deletedDatabasePath)).toBe("delete");

      await runTurn(SURVIVOR_AGENT.id, "after-delete");
      await refreshCatalog(SURVIVOR_AGENT.id);
      await expect(client.request("secrets.reload", {})).resolves.toBeDefined();
      await hotReload("24h");
      await sleep(3_000);
      await runTurn(SURVIVOR_AGENT.id, "after-reload");
      const survivor = await memory.runtime.getMemorySearchManager({
        cfg: memoryConfig,
        agentId: SURVIVOR_AGENT.id,
      });
      expect(survivor.manager, survivor.error).not.toBeNull();

      expect(await listOpenSqliteFamilyPaths(deletedDatabasePath)).toEqual([]);
      expect(leaveWalMode(deletedDatabasePath)).toBe("delete");
      expect(await listOpenSqliteFamilyPaths(survivorDatabasePath)).not.toEqual([]);

      // Re-creating the agent admits its retained database to readers again.
      await expect(
        client.request("agents.create", {
          name: DELETED_AGENT.name,
          workspace: state.path(`workspace-${DELETED_AGENT.id}`),
        }),
      ).resolves.toMatchObject({ agentId: DELETED_AGENT.id, ok: true });
      const revivedKey = `agent:${DELETED_AGENT.id}:revived`;
      await expect
        .poll(
          () =>
            client.request("sessions.create", { agentId: DELETED_AGENT.id, key: revivedKey }).then(
              () => "ok",
              (error: unknown) => String(error),
            ),
          { timeout: 30_000, interval: 250 },
        )
        .toBe("ok");
      const revived = await client.request<{ sessions: Array<{ key: string }> }>("sessions.list", {
        agentId: DELETED_AGENT.id,
        limit: 100,
      });
      expect(revived.sessions.map((entry) => entry.key)).toContain(revivedKey);
    },
  );
});
