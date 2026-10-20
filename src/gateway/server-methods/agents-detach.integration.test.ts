import "../server-start.js";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

it("detaches without erasing history, fences a restarted source, and adopts its existing store", async () => {
  await withOpenClawTestState(
    { label: "agent-detach-rpc", env: deletionGatewayEnv },
    async (state) => {
      const token = "synthetic-detach-test-token";
      await state.writeConfig({
        gateway: { mode: "local", auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true, heartbeat: { every: "0m" } },
          entries: {
            keeper: { workspace: state.workspaceDir },
            traveler: { workspace: state.path("traveler-workspace") },
          },
        },
        plugins: { enabled: false },
      });
      const claim = await acquireTestPortBlock({ offsets: [0, 2] });
      const start = () =>
        startGatewayServer(claim.port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
          hotReloadRecovery: () => {
            throw new Error("Agent detach unexpectedly required a Gateway recovery restart");
          },
        });
      const connect = () =>
        connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: ["operator.admin"],
        });
      let server = await start();
      let client: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        await server.startupSettled;
        client = await connect();
        const key = "agent:traveler:handoff";
        const created = await client.request<{ sessionId: string }>("sessions.create", {
          agentId: "traveler",
          key,
        });
        await client.request("chat.inject", {
          sessionKey: key,
          message: "Preserve this transcript across detach.",
        });
        await expect(
          client.request("agents.detach", { agentId: "traveler", deleteFiles: true }),
        ).rejects.toThrow("invalid agents.detach params");
        await expect(
          client.request("agents.detach", { agentId: "traveler" }),
        ).resolves.toMatchObject({ ok: true, agentId: "traveler" });
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Refused source write" }),
        ).rejects.toThrow();
        await client.request("sessions.create", {
          agentId: "keeper",
          key: "agent:keeper:unaffected",
        });
        await disconnectGatewayClient(client);
        client = undefined;
        await server.close();
        server = await start();
        await server.startupSettled;
        client = await connect();
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Refused after restart" }),
        ).rejects.toThrow();
        await client.request("agents.create", {
          name: "traveler",
          workspace: state.path("traveler-workspace"),
        });
        const history = await client.request<{ sessionId: string; messages: unknown[] }>(
          "chat.history",
          { sessionKey: key },
        );
        expect(history.sessionId).toBe(created.sessionId);
        expect(history.messages).toEqual([
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Preserve this transcript across detach." }],
          }),
        ]);
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Adopted agent can write" }),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        if (client) {
          await disconnectGatewayClient(client);
        }
        await server.close();
        await claim.release();
      }
    },
  );
});
