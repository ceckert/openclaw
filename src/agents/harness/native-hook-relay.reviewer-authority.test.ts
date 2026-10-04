import { afterEach, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  await testing.clearNativeHookRelaysForTests();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "rechecks reviewer authority at the relay handoff (deferred=%s)",
  async (deferred) => {
    const allowed = {
      blocked: false as const,
      params: {},
      assertExecutionActive: () => {
        throw new Error("resource authority changed");
      },
    };
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "reviewer-handoff",
      runId: "reviewer-handoff",
      runBeforeToolCall: async () =>
        deferred
          ? {
              blocked: false,
              params: {},
              deferredApproval: {
                approval: { title: "Owner", description: "Owner approval" },
                toolName: "fixture",
                baseParams: {},
              },
            }
          : allowed,
    });
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: { tool_name: "fixture", tool_use_id: "call", tool_input: {} },
    });
    if (!deferred) {
      await expect(invocation).rejects.toThrow("resource authority changed");
      return;
    }
    await invocation;
    testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(async () => allowed);
    await expect(
      resolveNativeHookRelayDeferredToolApproval({ relayId: relay.relayId, toolUseId: "call" }),
    ).rejects.toThrow("resource authority changed");
  },
);

it.each(["before", "during"] as const)(
  "refuses execution when reviewer authority closes %s native admission",
  async (revocation) => {
    let reviewerCurrent = revocation !== "before";
    const admit = vi.fn(() => {
      reviewerCurrent = false;
    });
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "reviewer-admission",
      runId: "reviewer-admission",
      runBeforeToolCall: async () => ({
        blocked: false,
        params: { command: "true" },
        assertExecutionActive: () => {
          if (!reviewerCurrent) {
            throw new Error("reviewer revoked during native admission");
          }
        },
      }),
      executionAdmission: { toolNames: ["exec"], admit },
    });
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_use_id: "call", tool_input: { command: "true" } },
      }),
    ).rejects.toThrow("reviewer revoked during native admission");
    expect(admit).toHaveBeenCalledTimes(revocation === "before" ? 0 : 1);
  },
);

it.each([
  { name: "tuple collision", toolIds: ["b:c", "c"] },
  { name: "relay prefix", toolIds: ["one", "two"] },
])("keeps deferred approvals with their exact relay across $name", async ({ toolIds }) => {
  const callbacks = [vi.fn(), vi.fn()];
  const relays = ["a", "a:b"].map((relayId, index) =>
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "tuple-session",
      runId: "tuple-run",
      runBeforeToolCall: async () => ({
        blocked: false,
        params: {},
        deferredApproval: {
          approval: { title: "fixture", description: "fixture", onResolution: callbacks[index] },
          toolName: "fixture",
          baseParams: {},
        },
      }),
    }),
  );
  for (const [index, relay] of relays.entries()) {
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: { tool_name: "fixture", tool_use_id: toolIds[index], tool_input: {} },
    });
  }
  expect(nativeHookRelayState.pendingPreToolUseApprovals.size).toBe(2);
  expect(callbacks[0]).not.toHaveBeenCalled();
  expect(callbacks[1]).not.toHaveBeenCalled();
  relays[0]!.unregister();
  expect(callbacks[0]).toHaveBeenCalledExactlyOnceWith("cancelled");
  expect(callbacks[1]).not.toHaveBeenCalled();
  const controller = new AbortController();
  const assertExecutionActive = () => controller.signal.throwIfAborted();
  testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(async () => ({
    blocked: false,
    params: {},
    approvalResolution: "allow-once",
    assertExecutionActive,
  }));
  const outcome = await resolveNativeHookRelayDeferredToolApproval({
    relayId: relays[1]!.relayId,
    toolUseId: toolIds[1],
  });
  expect(outcome).toEqual({ handled: true, outcome: "approved-once", assertExecutionActive });
  if (outcome?.outcome !== "approved-once") {
    throw new Error("Expected approval");
  }
  expect(() => outcome.assertExecutionActive?.()).not.toThrow();
  controller.abort(new Error("Reviewer authority revoked"));
  expect(() => outcome.assertExecutionActive?.()).toThrow("Reviewer authority revoked");
  expect(nativeHookRelayState.pendingPreToolUseApprovals.size).toBe(0);
});
