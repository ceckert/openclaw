import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  capturePluginApprovalReviewerGuard,
  type PluginApprovalReviewerGuard,
} from "../infra/plugin-approval-reviewer.js";
import type { PluginHookBeforeToolCallResult } from "../plugins/hook-before-tool-call-result.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const gateway = vi.mocked(callGatewayTool);
const ctx = {
  agentId: "main",
  runId: "run-owner-approval",
  approvalReviewerDeviceId: "requester-device",
};

function registerGuard(guard: PluginApprovalReviewerGuard) {
  const registry = createMockPluginRegistry([]);
  registry.typedHooks.push({
    hookName: "before_tool_call",
    pluginId: "deployment-managed-custom-plugin",
    source: "/config/extensions/custom/index.ts",
    handler: async (): Promise<PluginHookBeforeToolCallResult> => ({
      requireApproval: {
        title: "Allow computer control?",
        description: "Another Builder requests a computer action.",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 300_000,
        reviewerGuard: guard,
      },
    }),
  });
  initializeGlobalHookRunner(registry);
}

function createGuard() {
  const controller = new AbortController();
  const assertActive = vi.fn();
  const guard: PluginApprovalReviewerGuard = {
    signal: controller.signal,
    assertActive,
    prepare: async (reviewer) => (reviewer.userId === "current-owner" ? assertActive : null),
  };
  return { guard, controller, assertActive };
}

beforeEach(() => gateway.mockReset());
afterEach(() => {
  resetGlobalHookRunner();
  setEmbeddedMode(false);
  setEmbeddedPluginApprovalBroker(null);
});

describe("registered custom-plugin reviewer approval", () => {
  it("binds the guard through the native approval broker without binding to the requester device", async () => {
    const { guard } = createGuard();
    registerGuard(guard);
    let captured: PluginApprovalReviewerGuard | undefined;
    gateway.mockImplementation(async (method) => {
      if (method === "plugin.approval.request") {
        captured = capturePluginApprovalReviewerGuard();
        return { id: "guarded-approval", status: "accepted" };
      }
      return { id: "guarded-approval", decision: "allow-once" };
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "computer",
      params: { action: "click" },
      ctx,
    });
    expect(captured).toBe(guard);
    expect(gateway.mock.calls[0]?.[2]).not.toHaveProperty("approvalReviewerDeviceIds");
    expect(gateway.mock.calls[0]?.[2]).toMatchObject({
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(outcome).toMatchObject({
      blocked: false,
      approvalResolution: "allow-once",
      assertExecutionActive: expect.any(Function),
    });
  });

  it("fails closed if the transport cannot capture the process-local guard", async () => {
    registerGuard(createGuard().guard);
    gateway.mockResolvedValue({ id: "remote-approval", decision: "allow-once" });
    await expect(
      runBeforeToolCallHook({ toolName: "computer", params: {}, ctx }),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("checks live authority after approval and final parameter validation before execution", async () => {
    const { guard, assertActive } = createGuard();
    registerGuard(guard);
    gateway.mockImplementation(async () => {
      capturePluginApprovalReviewerGuard();
      return { id: "guarded-approval", decision: "allow-once" };
    });
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "computer",
        label: "Computer",
        description: "Computer fixture",
        parameters: Type.Object({}),
        execute,
      },
      ctx,
    );
    await expect(
      runWithToolExecutionValidation(
        "tool-owner-approval",
        async () => {
          await Promise.resolve();
          assertActive.mockImplementation(() => {
            throw new Error("requester disconnected");
          });
        },
        async () => tool.execute("tool-owner-approval", {}),
      ),
    ).rejects.toThrow("requester disconnected");
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels a pending decision when the guard lifetime ends", async () => {
    const { guard, controller } = createGuard();
    registerGuard(guard);
    let waitSignal: AbortSignal | undefined;
    gateway.mockImplementation(async (method, _options, _request, extra) => {
      if (method === "plugin.approval.request") {
        capturePluginApprovalReviewerGuard();
        return { id: "guarded-approval", status: "accepted" };
      }
      waitSignal = extra?.signal;
      controller.abort(new Error("computer lifetime ended"));
      waitSignal?.throwIfAborted();
      return { id: "guarded-approval", decision: "allow-once" };
    });
    const outcome = await runBeforeToolCallHook({ toolName: "computer", params: {}, ctx });
    expect(waitSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({ blocked: true });
  });

  it("does not send a guarded request to an embedded broker without reviewer enforcement", async () => {
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    const request = vi
      .spyOn(broker, "request")
      .mockResolvedValue({ id: "embedded", decision: "allow-once" });
    setEmbeddedPluginApprovalBroker(broker);
    const { guard } = createGuard();
    const outcome = await resolveBeforeToolCallApprovalOutcome({
      result: {
        requireApproval: {
          title: "Computer",
          description: "Owner approval",
          reviewerGuard: guard,
        },
      },
      toolName: "computer",
      baseParams: {},
    });
    expect(outcome).toMatchObject({ blocked: true });
    expect(request).not.toHaveBeenCalled();
  });
});
