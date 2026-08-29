import { describe, expect, it } from "vitest";
import type { SessionsDeleteResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "./test-helpers.js";

const SESSION_KEY = "agent:main:transient:archive-free-product-proof";
const SESSION_ID = "archive-free-product-proof";

installGatewayTestHooks();

describe("archive-free session transcript product proof", () => {
  it(
    "rejects write scope and lets admin purge through an authenticated real Gateway RPC",
    { timeout: 180_000 },
    async () => {
      const port = await getGatewayTestPort();
      const token = "archive-free-product-proof-token";
      const url = `ws://127.0.0.1:${port}`;
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: process.env,
      });
      const scope = {
        agentId: "main",
        env: process.env,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath,
      };
      const events = [
        { type: "session" as const, id: SESSION_ID, content: "one-shot product proof" },
      ];
      await upsertSessionEntryCore(scope, { sessionId: SESSION_ID, updatedAt: Date.now() });
      await replaceTranscriptEvents(scope, events);
      closeOpenClawAgentDatabasesForTest();

      const server = await startTestGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let adminClient: GatewayClient | undefined;
      let writeClient: GatewayClient | undefined;
      try {
        writeClient = await connectGatewayClient({
          url,
          token,
          role: "operator",
          scopes: ["operator.read", "operator.write"],
        });

        await expect(
          writeClient.request("sessions.delete", {
            key: SESSION_KEY,
            deleteTranscriptWithoutArchive: true,
          }),
        ).rejects.toThrow("missing scope: operator.admin");
        await expect(writeClient.request("health", { probe: true })).resolves.toBeDefined();
        expect(loadSessionEntry(scope)).toMatchObject({ sessionId: SESSION_ID });
        await expect(loadTranscriptEvents(scope)).resolves.toEqual(events);

        adminClient = await connectGatewayClient({
          url,
          token,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        const deleted = await adminClient.request<SessionsDeleteResult>("sessions.delete", {
          key: SESSION_KEY,
          deleteTranscriptWithoutArchive: true,
        });
        expect(deleted).toMatchObject({
          archived: [],
          deleted: true,
          key: SESSION_KEY,
          ok: true,
        });
        await expect(adminClient.request("health", { probe: true })).resolves.toBeDefined();

        const listed = await adminClient.request<{ sessions?: Array<{ key?: string }> }>(
          "sessions.list",
          { agentId: "main" },
        );
        expect(listed.sessions?.map(({ key }) => key)).not.toContain(SESSION_KEY);
        expect(loadSessionEntry(scope)).toBeUndefined();
        await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
      } finally {
        if (adminClient) {
          await disconnectGatewayClient(adminClient);
        }
        if (writeClient) {
          await disconnectGatewayClient(writeClient);
        }
        await server.close({ reason: "archive-free product proof complete" });
        closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
