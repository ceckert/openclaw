import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withoutPluginRuntimeGatewayRequestAuthority } from "../plugins/runtime/gateway-request-scope.js";

export function withChannelAccountStartContext<T>(
  approvalRuntime: GatewayNativeApprovalRuntime | undefined,
  start: () => T,
): T {
  return withoutGatewayToolCallerIdentity(() =>
    withoutPluginRuntimeGatewayRequestAuthority(() =>
      withGatewayNativeApprovalRuntime(approvalRuntime, start),
    ),
  );
}

export function waitForChannelStartupHandoff(): Promise<void> {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

export async function runChannelAccountMonitor<T>(
  registry: PluginRegistry,
  pluginId: string | null | undefined,
  start: () => Promise<T>,
): Promise<T> {
  const record = registry.plugins.find((entry) => entry.id === pluginId);
  const instance = record && getPluginInstance(record);
  if (instance && !instance.acceptingCalls) {
    throw new PluginInstanceUnavailableError(instance.pluginId);
  }
  // Host-owned monitor custody drains after stop and cannot block replacement admission.
  const consumer = instance?.retainConsumer(undefined, undefined, "custody");
  try {
    return await (consumer ? consumer.run(start) : start());
  } finally {
    consumer?.release();
  }
}
