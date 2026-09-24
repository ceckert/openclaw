import type { ApprovalScope } from "../infra/approval-scope.js";
import type { PluginApprovalReviewerGuard } from "../infra/plugin-approval-reviewer.js";
import { cloneHookIsolationValue } from "./hook-isolation.js";

export const PluginApprovalResolutions = {
  ALLOW_ONCE: "allow-once",
  ALLOW_ALWAYS: "allow-always",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
} as const;

export type PluginApprovalResolution =
  (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    scope?: ApprovalScope;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    /**
     * @deprecated Unresolved approvals always deny; retained for plugin API
     * compatibility. The field will be removed after one deprecation release train.
     */
    timeoutBehavior?: "allow" | "deny";
    /** Override timeout text and return the timeout as a blocked tool result. */
    timeoutReason?: string;
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    reviewerGuard?: PluginApprovalReviewerGuard;
    onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
  };
};

export function mergeBeforeToolCallResult(
  acc: PluginHookBeforeToolCallResult | undefined,
  next: PluginHookBeforeToolCallResult,
  registration: { pluginId: string },
): PluginHookBeforeToolCallResult {
  if (acc?.block === true) {
    return acc;
  }
  const approvalAlreadyRequested = acc?.requireApproval !== undefined;
  if (approvalAlreadyRequested && next.requireApproval?.reviewerGuard) {
    return {
      ...acc,
      block: true,
      blockReason: "Conflicting plugin approvals require separate reviewer policies",
    };
  }
  let params = next.params ?? acc?.params;
  if (approvalAlreadyRequested) {
    params = acc?.params;
  } else if (next.requireApproval && params !== undefined) {
    // Approval covers one detached snapshot. Later hooks may still block,
    // but they cannot change what the operator reviewed.
    params = cloneHookIsolationValue("before_tool_call", params);
  }
  return {
    params,
    block: next.block === true ? true : undefined,
    blockReason: next.blockReason ?? acc?.blockReason,
    requireApproval:
      acc?.requireApproval ??
      (next.requireApproval
        ? { ...next.requireApproval, pluginId: registration.pluginId }
        : undefined),
  };
}
