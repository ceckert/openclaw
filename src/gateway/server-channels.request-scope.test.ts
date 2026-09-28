import { afterEach, expect, it } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { captureAmbientGatewayOperatorAuthority } from "./operator-invocation-authority.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { createTestPlugin, type TestAccount } from "./server-channels.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

let manager: ChannelManager | undefined;

afterEach(async () => {
  await manager?.stopChannel("discord").catch(() => {});
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

function installPlugin(startAccount: (ctx: ChannelGatewayContext<TestAccount>) => Promise<void>) {
  const registry = createEmptyPluginRegistry();
  const plugin = createTestPlugin({ startAccount });
  registry.channels.push({ pluginId: plugin.id, source: "test", plugin } as never);
  setActivePluginRegistry(registry);
}

function createManagerForTest() {
  const log = createSubsystemLogger("gateway/server-channels-request-scope-test");
  manager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => ({}),
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: { discord: log } as never,
    channelRuntimeEnvs: { discord: runtimeForLogger(log) } as unknown as Record<string, RuntimeEnv>,
  });
  return manager;
}

it("a channel account started by a Gateway request keeps the Gateway binding but not the request's client authority", async () => {
  const context = {} as GatewayRequestContext;
  const resolveGatewayContext = () => context;
  const inboundTurn = createDeferredCore<{
    scope: PluginRuntimeGatewayRequestScope | undefined;
    ambientAuthority: Promise<unknown>;
  }>();
  installPlugin(async () => {
    // A later inbound event fires from the same async context the monitor was started in.
    queueMicrotask(() => {
      const scope = getPluginRuntimeGatewayRequestScope();
      inboundTurn.resolve({
        scope,
        ambientAuthority: captureAmbientGatewayOperatorAuthority({
          missingBindingError: () => new Error("missing binding"),
        }).then(
          (authority) => ({ authority }),
          (error: unknown) => ({ error }),
        ),
      });
    });
  });
  const requestClient = {
    connId: "config-patch-conn",
    connect: { role: "operator", scopes: ["operator.admin"], client: { id: "test" } },
    internal: {},
  } as never;

  await withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:main" },
    async () =>
      await withPluginRuntimeGatewayRequestScope(
        {
          context,
          resolveGatewayContext,
          client: requestClient,
          signal: new AbortController().signal,
          hasCurrentClientAuthority: () => false,
          isWebchatConnect: () => false,
        },
        () => createManagerForTest().startChannel("discord"),
      ),
  );

  const turn = await inboundTurn.promise;
  expect(turn.scope?.resolveGatewayContext?.()).toBe(context);
  expect(turn.scope?.client).toBeUndefined();
  expect(turn.scope?.hasCurrentClientAuthority).toBeUndefined();
  expect(turn.scope?.signal).toBeUndefined();
  await expect(turn.ambientAuthority).resolves.toEqual({ authority: {} });
});
