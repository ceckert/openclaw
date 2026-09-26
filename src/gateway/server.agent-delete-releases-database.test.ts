import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSqliteReaderDiagnosticsForPath } from "../infra/sqlite-reader-lifecycle.js";
import { registerMemoryCapability } from "../plugins/memory-state.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "../state/openclaw-agent-db-readonly-open.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

const AGENT_ID = "departing-coach";

installGatewayTestHooks();

async function withPublishedDepartingAgent(
  run: (params: { client: GatewayClient; databasePath: string }) => Promise<void>,
): Promise<void> {
  // Session creation compares lexical and physical store paths, so the state dir must
  // already be canonical (macOS os.tmpdir() sits behind the /var -> /private/var link).
  const stateDir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-agent-delete-release-"),
  );
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const token = "agent-delete-releases-database-token";
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const server = await startTestGatewayServer(portClaim, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: GatewayClient | undefined;
      try {
        client = await connectGatewayClient({
          url: `ws://127.0.0.1:${portClaim.port}`,
          token,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await client.request("agents.create", {
          name: "Departing Coach",
          workspace: path.join(stateDir, "ws-departing"),
        });
        await client.request("sessions.create", {
          agentId: AGENT_ID,
          key: `agent:${AGENT_ID}:main`,
        });
        await client.request("secrets.reload", {});
        const databasePath = resolveOpenClawAgentSqlitePath({
          agentId: AGENT_ID,
          env: process.env,
        });
        expect(databasePath.startsWith(stateDir)).toBe(true);
        await run({ client, databasePath });
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close({ reason: "agent delete database release complete" });
      }
    });
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** A memory index keeps a query-only connection to its agent's database, as memory-core does. */
function registerAgentDatabaseMemoryIndex() {
  const indexes = new Map<string, OpenClawAgentReadOnlyDatabaseHandle>();
  const runtime: MemoryPluginRuntime = {
    async getMemorySearchManager({ agentId }) {
      const opened = openOpenClawAgentDatabaseReadOnly({ agentId, env: process.env });
      if (!opened.found) {
        return { manager: null, error: opened.reason };
      }
      opened.database.db.prepare("SELECT count(*) FROM sqlite_schema").get();
      indexes.set(agentId, opened.database);
      return { manager: null };
    },
    resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
    async closeMemorySearchManager({ agentId }) {
      indexes.get(agentId)?.close();
      indexes.delete(agentId);
    },
  };
  registerMemoryCapability("agent-delete-memory-index", { runtime });
  return { runtime, indexes };
}

describe("agents.delete database release", () => {
  it(
    "leaves no connection to a published agent's database after deletion",
    { timeout: 180_000 },
    async () => {
      await withPublishedDepartingAgent(async ({ client, databasePath }) => {
        await client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: false });

        expect(readSqliteReaderDiagnosticsForPath(databasePath).connections).toEqual([]);
      });
    },
  );

  it(
    "retires the deleted agent's memory index so its database has no remaining reader",
    { timeout: 180_000 },
    async () => {
      await withPublishedDepartingAgent(async ({ client, databasePath }) => {
        const memory = registerAgentDatabaseMemoryIndex();
        await memory.runtime.getMemorySearchManager({ cfg: {}, agentId: AGENT_ID });
        expect(memory.indexes.get(AGENT_ID)?.db.isOpen).toBe(true);

        await client.request("agents.delete", { agentId: AGENT_ID, deleteFiles: false });

        expect(memory.indexes.has(AGENT_ID)).toBe(false);
        // SQLite removes the WAL only when the last connection in the process closes.
        expect(existsSync(`${databasePath}-wal`)).toBe(false);
      });
    },
  );
});
