/**
 * Proves `startManagedGatewayConfigReloader` forwards the underlying watcher's
 * live `hotReloadStatus()` accessor and owns cache invalidation at the accepted
 * candidate seam. This keeps request caching coupled to the actual watcher
 * lifecycle instead of individual config writers.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";

const hoisted = vi.hoisted(() => ({
  hotReloadStatus: { current: "active" as "active" | "disabled" },
  invalidateConfigGetResponseCache: vi.fn(),
  onConfigCandidateCommitted: undefined as
    | ((info: {
        path: string;
        persistedHash: string | null;
        changedPaths: readonly string[];
      }) => void)
    | undefined,
  onRuntimeConfigCommitted: undefined as Parameters<
    typeof import("./config-reload.js").startGatewayConfigReloader
  >[0]["onRuntimeConfigCommitted"],
  stop: vi.fn(async () => {}),
}));

vi.mock("./config-get-response.js", () => ({
  invalidateConfigGetResponseCache: hoisted.invalidateConfigGetResponseCache,
}));

vi.mock("./config-reload.js", async () => {
  const actual = await vi.importActual<typeof import("./config-reload.js")>("./config-reload.js");
  return {
    ...actual,
    startGatewayConfigReloader: vi.fn(
      (options: {
        onConfigCandidateCommitted?: (info: {
          path: string;
          persistedHash: string | null;
          changedPaths: readonly string[];
        }) => void;
        onRuntimeConfigCommitted?: Parameters<
          typeof import("./config-reload.js").startGatewayConfigReloader
        >[0]["onRuntimeConfigCommitted"];
      }) => {
        hoisted.onConfigCandidateCommitted = options.onConfigCandidateCommitted;
        hoisted.onRuntimeConfigCommitted = options.onRuntimeConfigCommitted;
        return {
          ready: Promise.resolve(),
          isReady: () => true,
          stop: hoisted.stop,
          hotReloadStatus: () => hoisted.hotReloadStatus.current,
          isReloading: () => false,
          applyPluginLifecycleChange: vi.fn(),
        };
      },
    ),
  };
});

describe("startManagedGatewayConfigReloader hotReloadStatus plumbing", () => {
  it("forwards live status and invalidates config.get on watcher commit", async () => {
    const initialConfig: OpenClawConfig = {
      session: { store: "/tmp/sessions.json" },
      models: {
        providers: { demo: { baseUrl: "https://example.invalid", apiKey: "resolved", models: [] } },
      },
    };
    const sourceFor = (id: string): OpenClawConfig => ({
      ...initialConfig,
      models: {
        providers: {
          demo: {
            ...initialConfig.models!.providers!.demo!,
            apiKey: { source: "env", provider: "default", id },
          },
        },
      },
    });
    const initialSource = sourceFor("DEMO_KEY");
    const pluginRegistry = createEmptyPluginRegistry();
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: initialConfig,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    setPluginRuntimeLoadContext(
      pluginRegistry,
      resolvePluginRuntimeLoadContext({
        config: initialConfig,
        activationSourceConfig: initialSource,
        metadataSnapshot,
      }),
    );
    const broadcast = vi.fn();
    const invalidateMentions = vi.fn();
    const gatewayContext = {
      mentionInbox: { invalidate: invalidateMentions },
    } as unknown as GatewayRequestContext;
    const reloader = startManagedGatewayConfigReloader({
      getPluginRegistry: () => pluginRegistry,
      configRevisionProjector: {
        projectRawHash: (hash) => `opaque:${hash}`,
        projectResolvedHash: (hash) => `resolved:${hash}`,
      },
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialSnapshotRawHash: null,
      initialAuthoredConfig: {},
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      watchPath: "/tmp/openclaw.json",
      readSnapshot: vi.fn() as never,
      promoteSnapshot: vi.fn(async () => true) as never,
      subscribeToWrites: vi.fn(() => () => {}) as never,
      deps: {} as never,
      broadcast,
      resolveGatewayContext: () => gatewayContext,
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
        cronState: {
          cron: { start: vi.fn(async () => {}), stop: vi.fn() },
          storePath: "/tmp/cron.json",
          cronEnabled: false,
          reconcileExitWatchers: vi.fn(async () => {}),
          reconcileStreamWatchers: vi.fn(async () => {}),
          stopStreamWatchers: vi.fn(async () => {}),
          reconcileSystemJobs: vi.fn(async () => "converged" as const),
        } as never,
      }),
      setState: vi.fn(),
      startChannel: vi.fn(async () => new Map()),
      stopChannel: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => {
        throw new Error("Unexpected plugin reload while observing config status");
      }),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      cronReconciliation: {
        arm: () => ({ complete: async () => {} }),
        invalidate: vi.fn(),
      },
      channelManager: {} as never,
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(),
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      }),
      prepareTerminalConfig: vi.fn(),
      reconcileRuntimePolicy: vi.fn(),
      commitRuntimePolicy: vi.fn(),
      acceptTerminalConfig: vi.fn(),
      clients: [],
    });
    await reloader.ready;

    expect(reloader.hotReloadStatus).toBeTypeOf("function");
    expect(reloader.hotReloadStatus?.()).toBe("active");

    // Flip the underlying watcher's live state without recreating the managed
    // handle — a copied/snapshotted value would stay stuck on "active".
    hoisted.hotReloadStatus.current = "disabled";
    expect(reloader.hotReloadStatus?.()).toBe("disabled");

    hoisted.onConfigCandidateCommitted?.({
      path: "/tmp/openclaw.json",
      persistedHash: "persisted-1",
      changedPaths: ["gateway.port"],
    });
    expect(hoisted.invalidateConfigGetResponseCache).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "config.changed",
      { path: "/tmp/openclaw.json", hash: "opaque:persisted-1", ts: expect.any(Number) },
      { dropIfSlow: true },
    );
    expect(invalidateMentions).not.toHaveBeenCalled();

    hoisted.onRuntimeConfigCommitted?.(
      buildGatewayReloadPlan(["gateway.roles"]),
      initialConfig,
      initialSource,
    );
    expect(invalidateMentions).toHaveBeenCalledOnce();

    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("committed-policy@example.test");
      gatewayContext.getRuntimeConfig = () => getRuntimeConfigSnapshot() ?? initialConfig;
      gatewayContext.getCommittedRuntimeConfig = expectDefined(
        reloader.getCommittedRuntimeConfig,
        "committed runtime config reader",
      );
      gatewayContext.resolveGatewayContext = () => gatewayContext;
      const capture = async () =>
        expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: createSyntheticPluginRuntimeClient({
              scopes: ["operator.write"],
              operatorRoleActor: { kind: "operator", profileId: profile.id },
            }),
            context: gatewayContext,
          }),
          "operator source",
        );
      const original = await capture();
      let duringActivation: Awaited<ReturnType<typeof capture>> | undefined;
      const candidate: OpenClawConfig = {
        ...initialConfig,
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      const candidateSource = { ...initialSource, gateway: candidate.gateway };
      try {
        setRuntimeConfigSnapshot(candidate, candidateSource);
        expect(original.authority.signal?.aborted).toBe(false);
        expect(() => original.authority.assertCurrent()).not.toThrow();
        duringActivation = await capture();
        // An unrelated Gateway publication cannot turn this tentative policy into source loss.
        publishOperatorRoleConfigChange({});
        expect(duringActivation.authority.signal?.aborted).toBe(false);
        setRuntimeConfigSnapshot(initialConfig);
        expect(duringActivation.authority.assertCurrent).not.toThrow();
        expect(original.authority.signal?.aborted).toBe(false);

        setRuntimeConfigSnapshot(candidate, candidateSource);
        hoisted.onRuntimeConfigCommitted?.(
          buildGatewayReloadPlan(["gateway.roles"]),
          candidate,
          candidateSource,
        );
        expect(gatewayContext.getCommittedRuntimeConfig()).toBe(candidate);
        const retainedContext = getPluginRuntimeLoadContext(pluginRegistry);
        expect(retainedContext?.rawConfig).toBe(candidate);
        expect(retainedContext?.activationSourceConfig).toBe(candidateSource);
        expect(retainedContext?.metadataSnapshot).toBe(metadataSnapshot);
        const changedSource = { ...sourceFor("OTHER_KEY"), gateway: candidate.gateway };
        const referencePlan = buildGatewayReloadPlan(["models.providers.demo.apiKey"]);
        expect(referencePlan.reloadPlugins).toBe(false);
        setRuntimeConfigSnapshot(candidate, changedSource);
        hoisted.onRuntimeConfigCommitted?.(referencePlan, candidate, changedSource);
        expect(getPluginRuntimeLoadContext(pluginRegistry)).toBe(retainedContext);
        const pluginChange = { ...candidate, plugins: { enabled: false } };
        hoisted.onRuntimeConfigCommitted?.(
          { ...buildGatewayReloadPlan(["plugins.enabled"]), reloadPlugins: true },
          pluginChange,
          pluginChange,
        );
        expect(getPluginRuntimeLoadContext(pluginRegistry)).toBe(retainedContext);
        expect(original.authority.signal?.aborted).toBe(true);
        expect(duringActivation.authority.signal?.aborted).toBe(true);
      } finally {
        original.release();
        duringActivation?.release();
        clearRuntimeConfigSnapshot();
      }
    });

    await reloader.stop();
    expect(hoisted.stop).toHaveBeenCalledOnce();
  });
});
