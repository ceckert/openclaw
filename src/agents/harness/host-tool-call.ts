import { runBeforeToolCallHook, type HookContext } from "../agent-tools.before-tool-call.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import type { prepareHostWorkspaceReadiness } from "./host-capability-workspace.js";

export function createHarnessBeforeToolCall(params: {
  denyToolCalls: boolean;
  beforeToolCall: ReturnType<typeof prepareHostWorkspaceReadiness>["beforeToolCall"];
  hookContextForOperation: (operation?: Readonly<{ cwd?: string }>) => HookContext;
}) {
  return async (
    assertCurrent: () => void,
    {
      nativeOperation,
      approvalMode,
      ...request
    }: Parameters<AgentHarnessHostCapabilities["runBeforeToolCall"]>[0],
  ) => {
    assertCurrent();
    if (params.denyToolCalls) {
      return {
        blocked: true as const,
        kind: "veto" as const,
        reason: "Tool calls are denied for this side question.",
      };
    }
    if (params.beforeToolCall) {
      await params.beforeToolCall(request, assertCurrent);
    }
    const hostApprovalMode = approvalMode === "defer" ? "defer" : "request";
    const actionHookContext = params.hookContextForOperation(nativeOperation);
    const result = await runBeforeToolCallHook({
      ...request,
      approvalMode: hostApprovalMode,
      ctx: actionHookContext,
    });
    assertCurrent();
    if (!result.blocked) {
      result.assertExecutionActive?.();
    }
    return result;
  };
}
