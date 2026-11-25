import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/hook-before-tool-call-result.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));
afterEach(() => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  vi.mocked(callGatewayTool).mockReset();
});

function client(userId: string, deviceId: string): GatewayClient {
  return {
    connId: deviceId,
    authenticatedUserId: userId,
    connectionSignal: new AbortController().signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      device: {
        id: deviceId,
        publicKey: "fixture",
        signature: "fixture",
        signedAt: 1,
        nonce: "fixture",
      },
    },
  };
}

it.each(["allow", "changed-computer"] as const)(
  "binds the native tool approval to its verified owner and physical computer (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scheduler = createTestGatewayScheduler();
      const databaseOptions = { env: state.env };
      openOpenClawStateDatabase(databaseOptions);
      const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
        scheduler,
        approvalKind: "plugin",
        persistence: { runtimeEpoch: "owner-boundary", databaseOptions },
        resolveAllowedDecisions: resolvePluginApprovalRequestAllowedDecisions,
      });
      const handlers = createPluginApprovalHandlers(manager);
      const cfg = {};
      const logGateway = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const context = {
        getRuntimeConfig: () => cfg,
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        getApprovalClientConnIds: () => new Set(["owner-device", "member-device"]),
        hasExecApprovalClients: () => true,
        logGateway,
      } as unknown as GatewayRequestHandlerOptions["context"];
      const accepted = createDeferredCore<string>();
      const transportFailures: unknown[] = [];
      const controller = new AbortController();
      let computerInstanceId = "gce-vm:123";
      const originalComputer = computerInstanceId;
      const prepared = vi.fn(async (reviewer: { userId?: string; deviceId?: string }) => {
        if (reviewer.userId !== "owner@example.test") {
          return null;
        }
        if (computerInstanceId !== originalComputer) {
          throw new Error("Physical computer changed");
        }
        return () => {
          controller.signal.throwIfAborted();
          if (computerInstanceId !== originalComputer) {
            throw new Error("Physical computer changed");
          }
        };
      });
      const registry = createMockPluginRegistry([]);
      registry.typedHooks.push({
        hookName: "before_tool_call",
        pluginId: "deployment-managed-computer",
        source: "fixture",
        handler: (): PluginHookBeforeToolCallResult => ({
          requireApproval: {
            title: "Allow computer control?",
            description: "Control the selected physical computer",
            allowedDecisions: ["allow-once", "deny"],
            reviewerGuard: {
              signal: controller.signal,
              assertActive: () => controller.signal.throwIfAborted(),
              prepare: prepared,
            },
          },
        }),
      });
      initializeGlobalHookRunner(registry);
      const requester = client("member@example.test", "requester-device");
      const completions = new Set<Promise<void>>();
      const dispatch = async (method: string, params: unknown, requesterClient: GatewayClient) => {
        const responded = createDeferredCore<unknown>();
        const completion = Promise.resolve(
          handlers[method]!({
            req: { id: "boundary-request", type: "req", method, params },
            params,
            client: requesterClient,
            context,
            isWebchatConnect: () => true,
            respond: (ok, payload, error) => {
              responded.resolve({ ok, payload, error });
            },
          } as GatewayRequestHandlerOptions),
        );
        completions.add(completion);
        void completion.then(
          () => completions.delete(completion),
          (error: unknown) => {
            completions.delete(completion);
            responded.reject(error);
          },
        );
        return await responded.promise;
      };
      vi.mocked(callGatewayTool).mockImplementation(async (method, _options, params) => {
        const result = (await dispatch(method, params, requester).catch((error: unknown) => {
          transportFailures.push(error);
          throw error;
        })) as {
          ok: boolean;
          payload?: { id?: string };
          error?: { message?: string };
        };
        if (!result.ok) {
          const error = new Error(result.error?.message ?? "Native approval refused");
          transportFailures.push(error);
          transportFailures.push(...logGateway.error.mock.calls.flat().map(String));
          throw error;
        }
        if (method === "plugin.approval.request") {
          if (!result.payload?.id) {
            throw new Error("Native approval did not return an ID");
          }
          accepted.resolve(result.payload.id);
        }
        return result.payload;
      });
      const effect = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "applied" }],
        details: {},
      }));
      const tool = wrapToolWithBeforeToolCallHook(
        {
          name: "computer",
          label: "Computer",
          description: "Synthetic physical input",
          parameters: Type.Object({}),
          execute: effect,
        },
        {
          agentId: "main",
          runId: "native-owner-run",
          approvalReviewerDeviceId: "requester-device",
        },
      );
      const pending = tool.execute("native-owner-call", {});
      void pending.catch(() => {});
      try {
        const id = await Promise.race([
          accepted.promise,
          pending.then(
            () => {
              throw new Error("Tool settled without a native pending approval");
            },
            (error: unknown) => {
              expect(callGatewayTool).toHaveBeenCalled();
              throw new AggregateError(
                [error, ...transportFailures],
                "Native approval failed before acceptance",
              );
            },
          ),
        ]);
        const unrelated = (await dispatch(
          "plugin.approval.resolve",
          { id, decision: "allow-once" },
          client("member@example.test", "member-device"),
        )) as { ok: boolean };
        expect(unrelated.ok).toBe(false);
        expect(await getOperatorApprovalDetailed({ id, databaseOptions })).toMatchObject({
          outcome: "found",
          record: { status: "pending", decision: null },
        });
        expect(effect).not.toHaveBeenCalled();
        if (mode === "changed-computer") {
          computerInstanceId = "gce-vm:456";
        }
        const owner = (await dispatch(
          "plugin.approval.resolve",
          { id, decision: "allow-once" },
          client("owner@example.test", "different-owner-device"),
        )) as { ok: boolean };
        expect(owner.ok).toBe(mode === "allow");
        expect(prepared).toHaveBeenLastCalledWith(
          expect.objectContaining({
            userId: "owner@example.test",
            deviceId: "different-owner-device",
          }),
        );
        if (mode === "allow") {
          await expect(pending).resolves.toMatchObject({ content: [{ text: "applied" }] });
          expect(effect).toHaveBeenCalledOnce();
          expect(await getOperatorApprovalDetailed({ id, databaseOptions })).toMatchObject({
            outcome: "found",
            record: { status: "allowed", decision: "allow-once" },
          });
        } else {
          expect(await getOperatorApprovalDetailed({ id, databaseOptions })).toMatchObject({
            outcome: "found",
            record: { status: "pending", decision: null },
          });
          controller.abort(new Error("Original physical computer retired"));
          await expect(pending).rejects.toThrow("Approval cancelled (run aborted)");
          expect(effect).not.toHaveBeenCalled();
        }
      } finally {
        controller.abort(new Error("Owner boundary fixture closed"));
        await manager.drain();
        await Promise.allSettled([...completions, pending]);
        await scheduler.stop();
      }
    });
  },
);
