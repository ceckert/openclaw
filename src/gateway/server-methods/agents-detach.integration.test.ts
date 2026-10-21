import "../server-start.js";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

it.each([false, true])("preserves detached state (held: %s)", async (migrationHeld) => {
  await withOpenClawTestState(
    { label: "agent-detach-rpc", env: deletionGatewayEnv },
    async (state) => {
      const token = "synthetic-detach-test-token";
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
        const job = await client.request<{ id: string }>("cron.add", {
          name: "Synthetic traveler schedule",
          agentId: "traveler",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Synthetic schedule", toolsAllow: [] },
          delivery: { mode: "none" },
        });
        if (migrationHeld) {
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "hold",
            agentIds: ["traveler"],
          });
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "export",
          });
        }
        const expectSourceCronDenied = async () => {
          const result = await client!.request<{ ran: boolean }>("cron.run", {
            id: job.id,
            mode: "force",
          });
          expect(result).toMatchObject({ ok: true, ran: false });
        };
        await expect(
          client.request("agents.detach", { agentId: "traveler", deleteFiles: true }),
        ).rejects.toThrow("invalid agents.detach params");
        await expect(
          client.request("agents.detach", { agentId: "traveler" }),
        ).resolves.toMatchObject({ ok: true, agentId: "traveler" });
        await expect(
          client.request("chat.inject", { sessionKey: key, message: "Refused source write" }),
        ).rejects.toThrow();
        await expectSourceCronDenied();
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
        await expectSourceCronDenied();
        await client.request("agents.create", {
          name: "traveler",
          workspace: state.path("traveler-workspace"),
        });
        if (migrationHeld) {
          await expect(
            client.request("cron.update", { id: job.id, patch: { name: "Still held" } }),
          ).rejects.toThrow("is held for migration traveler-handoff");
          await client.request("cron.migration", {
            operationId: "traveler-handoff",
            phase: "resume",
          });
        }
        const retained = await client.request<{
          jobs: { id: string; agentId?: string; name: string }[];
        }>("cron.list", {
          includeDisabled: true,
        });
        expect(retained.jobs).toContainEqual(
          expect.objectContaining({
            id: job.id,
            agentId: "traveler",
            name: "Synthetic traveler schedule",
          }),
        );
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
        await client.request("agents.delete", { agentId: "traveler", deleteFiles: false });
        const deleted = await client.request<{ jobs: { id: string; agentId?: string }[] }>(
          "cron.list",
          {
            includeDisabled: true,
          },
        );
        expect(deleted.jobs.filter((entry) => entry.agentId === "traveler")).toEqual([]);
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
