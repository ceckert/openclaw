// A committed hot reload hands its slow prepared-model-runtime tail to the newer
// config's reload instead of finishing a runtime refresh that is already stale.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigWriteNotification } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  hashRuntimeConfigValue,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { buildGatewayReloadPlan, type GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import {
  closeTestConfigReloaders,
  createWriteReloaderHarness,
  makeSnapshot,
  prepareConfigReloadTest,
  waitForReloadState,
} from "./config-reload.test-support.js";
import {
  createDefaultGatewayReloadState,
  createHotTailPlan,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import {
  createMockRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

type Refresh = {
  config: OpenClawConfig;
  agentIds: ReadonlySet<string> | undefined;
  settle: ReturnType<typeof createDeferred<void>>;
};

const hoisted = vi.hoisted(() => ({
  refreshes: [] as Refresh[],
  staleScopes: [] as Array<ReadonlySet<string> | undefined>,
  refreshContextWindowCache: vi.fn(async (_config: OpenClawConfig) => {}),
}));

vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  advancePreparedModelRuntimeConfig: vi.fn(),
  markPreparedModelRuntimeSnapshotsStale: (
    _reason?: string,
    options?: { agentIds?: ReadonlySet<string> },
  ) => {
    hoisted.staleScopes.push(options?.agentIds);
    return Symbol("replacement-gate");
  },
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: (
    config: OpenClawConfig,
    options: { agentIds?: ReadonlySet<string> },
  ) => {
    const settle = createDeferred();
    hoisted.refreshes.push({ config, agentIds: options.agentIds, settle });
    return settle.promise;
  },
}));

vi.mock("../agents/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/context.js")>()),
  refreshContextWindowCache: (config: OpenClawConfig) => hoisted.refreshContextWindowCache(config),
}));

vi.mock("../hooks/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/loader.js")>()),
  prepareInternalHooks: async () => ({ commit: () => {} }),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecordSync: vi.fn(),
}));

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readConfigSnapshotAuditRecord: () => null,
  readLatestConfigSnapshotAuditRecord: () => null,
  upsertConfigSnapshotAuditRecord: vi.fn(),
}));

beforeEach((context) => {
  prepareConfigReloadTest(context);
  setRuntimeConfigSnapshot({}, {});
  hoisted.refreshes.length = 0;
  hoisted.staleScopes.length = 0;
  hoisted.refreshContextWindowCache.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeTestConfigReloaders();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
});

function createHandlers(
  requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const })),
  overrides: Partial<import("./server-reload-contracts.js").GatewayReloadHandlerParams> = {},
) {
  let state = createDefaultGatewayReloadState();
  const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
    scheduler: createTestGatewayScheduler(),
    getPluginRegistry: requireActivePluginChannelRegistry,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => state,
    setState: (nextState: typeof state) => {
      state = nextState;
    },
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    pruneInactiveChannelAccountState: vi.fn(),
    stopPostReadySidecars: vi.fn(),
    reloadPlugins: vi.fn(),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload,
    cronReconciliation: { arm: vi.fn(), complete: vi.fn(async () => {}), invalidate: vi.fn() },
    requestRecoveryRestart,
    ...overrides,
  } as never);
  return { handlers, logReload, requestRecoveryRestart };
}

function agentPlan(...agentIds: string[]): GatewayReloadPlan {
  return buildGatewayReloadPlan(agentIds.map((id) => `agents.entries.${id}.model`));
}

function publicationFor(
  config: OpenClawConfig,
  signal?: AbortSignal,
): Parameters<ReturnType<typeof createGatewayReloadHandlers>["applyHotReload"]>[2] {
  return {
    sourceConfig: config,
    isCurrent: () => !signal?.aborted,
    ...(signal ? { supersededSignal: signal } : {}),
    publish: async (commit) => await commit(),
  };
}

async function waitForRefreshCount(count: number) {
  await waitForReloadState(() => hoisted.refreshes.length >= count);
  return hoisted.refreshes[count - 1]!;
}

describe("superseded hot reload tail", () => {
  it.each([
    { tail: "pending", successor: "neutral" },
    { tail: "settled", successor: "neutral" },
    { tail: "pending", successor: "identical" },
    { tail: "settled", successor: "identical" },
    { tail: "pending", successor: "writer-none" },
    { tail: "pending", successor: "off" },
  ] as const)(
    "carries service debt through a managed $successor successor after a $tail model tail",
    { timeout: 10_000 },
    async ({ tail, successor }) => {
      const initialConfig: OpenClawConfig = { logging: { level: "info" } };
      const configA: OpenClawConfig = {
        ...initialConfig,
        agents: { entries: { alpha: { model: "openai/gpt-5.6-luna" } } },
      };
      const configB: OpenClawConfig =
        successor === "neutral"
          ? { ...configA, logging: { level: "debug" } }
          : successor === "off"
            ? { ...configA, gateway: { reload: { mode: "off" } } }
            : structuredClone(configA);
      const configC: OpenClawConfig =
        successor === "identical"
          ? structuredClone(configB)
          : { ...configB, logging: { level: "warn" } };
      const reloadPluginServices = vi.fn(async () => {});
      const { handlers, requestRecoveryRestart } = createHandlers(undefined, {
        reloadPluginServices,
      });
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      const applyHotReload = vi.fn<typeof handlers.applyHotReload>((plan, config, publication) =>
        handlers.applyHotReload(
          config === configA ? { ...plan, restartServices: new Set(["retained"]) } : plan,
          config,
          publication,
        ),
      );
      const managed = createManagedReloadSecretHandlers({
        ...handlers,
        applyHotReload,
        params: {
          activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
          clients: [],
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          commitRuntimePolicy: vi.fn(),
          reconcileRuntimePolicy: vi.fn(),
        },
        prepareRuntimeCandidate: (config) => config,
        tryPrepareRuntimeSecrets: async (config) => ({
          snapshot: makePreparedSecretsSnapshot(config),
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        }),
      });
      const harness = createWriteReloaderHarness({
        initialConfig,
        onHotReload: managed.onHotReload,
        onNoopConfigCommit: managed.onHotReload,
        onEffectiveConfigUnchanged: managed.onEffectiveConfigUnchanged,
        hasDeferredHotReload: handlers.hasDeferredHotReload,
      });
      const write = (
        config: OpenClawConfig,
        hash: string,
        revision: number,
        afterWrite?: ConfigWriteNotification["afterWrite"],
      ) =>
        harness.emitWrite({
          configPath: "/tmp/openclaw.json",
          sourceConfig: config,
          runtimeConfig: config,
          persistedHash: hash,
          snapshot: makeSnapshot({ config, hash }),
          revision,
          fingerprint: `runtime-${hash}`,
          sourceFingerprint: `source-${hash}`,
          writtenAtMs: Date.now(),
          ...(afterWrite ? { afterWrite } : {}),
        });
      await harness.reloader.ready;
      try {
        write(configA, "model-service-a", 1);
        const refreshA = await waitForRefreshCount(1);
        write(
          configB,
          "successor-b",
          2,
          successor === "writer-none"
            ? { mode: "none", reason: "leave runtime unchanged" }
            : undefined,
        );
        if (tail === "settled") {
          refreshA.settle.resolve();
          await refreshA.settle.promise;
        }
        await waitForReloadState(
          () =>
            applyHotReload.mock.calls.length === 2 ||
            harness.onConfigAccepted.mock.calls.some(([config]) => config === configB),
        );
        if (successor === "writer-none" || successor === "off") {
          expect(applyHotReload).toHaveBeenCalledOnce();
          expect(reloadPluginServices).not.toHaveBeenCalled();
          expect(handlers.hasDeferredHotReload()).toBe(true);
          return;
        }
        expect(applyHotReload).toHaveBeenCalledTimes(2);
        expect(harness.onEffectiveConfigUnchanged).not.toHaveBeenCalled();
        const refreshB = await waitForRefreshCount(2);
        expect(refreshB.config).toBe(configB);
        expect(reloadPluginServices).not.toHaveBeenCalled();
        refreshB.settle.resolve();
        await waitForReloadState(() => !harness.reloader.isReloading());
        expect(reloadPluginServices).toHaveBeenCalledExactlyOnceWith(
          configB,
          new Set(["retained"]),
        );
        refreshA.settle.resolve();
        await refreshA.settle.promise;
        write(configC, "neutral-c", 3);
        await waitForReloadState(() =>
          harness.onConfigAccepted.mock.calls.some(([config]) => config === configC),
        );
        expect(applyHotReload).toHaveBeenCalledTimes(2);
        expect(hoisted.refreshes).toHaveLength(2);
        expect(reloadPluginServices).toHaveBeenCalledOnce();
        expect(harness.onEffectiveConfigUnchanged).toHaveBeenCalledTimes(
          successor === "identical" ? 1 : 0,
        );
        expect(requestRecoveryRestart).not.toHaveBeenCalled();
      } finally {
        for (const refresh of hoisted.refreshes) {
          refresh.settle.resolve();
        }
        await harness.reloader.stop();
        handlers.stopRestartRetries();
      }
    },
  );

  it.each([false, true])(
    "clears service debt owned by a completed plugin replacement only while live (stopped: %s)",
    async (stopped) => {
      const reloadPluginServices = vi.fn(async () => {});
      const registry = {
        ...requireActivePluginChannelRegistry(),
        services: [
          {
            id: "retained",
            pluginId: "replacement",
            source: "test",
            origin: "bundled" as const,
            service: { id: "retained", start: vi.fn() },
          },
        ],
      };
      const reloadPlugins = vi.fn<
        import("./server-reload-contracts.js").GatewayReloadHandlerParams["reloadPlugins"]
      >(async ({ prepareConfigEffects, commitRuntime }) => {
        prepareConfigEffects({ pluginIds: new Set(["replacement"]), channels: new Set() }).retire();
        await commitRuntime();
        return makePluginReloadResult();
      });
      const { handlers } = createHandlers(undefined, {
        reloadPluginServices,
        reloadPlugins,
        getPluginRegistry: () => registry,
      });
      const supersession = new AbortController();
      const first = handlers.applyHotReload(
        { ...agentPlan("alpha"), restartServices: new Set(["retained"]) },
        {},
        publicationFor({}, supersession.signal),
      );
      const detached = await waitForRefreshCount(1);
      supersession.abort();
      await first;
      expect(handlers.hasDeferredHotReload()).toBe(true);
      const second = handlers.applyHotReload(
        createHotTailPlan({ reloadPlugins: true }),
        {},
        publicationFor({}),
      );
      const replacement = await waitForRefreshCount(2);
      if (stopped) {
        handlers.stopRestartRetries();
      }
      replacement.settle.resolve();
      await second;
      detached.settle.resolve();
      await detached.settle.promise;
      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(reloadPluginServices).not.toHaveBeenCalled();
      expect(handlers.hasDeferredHotReload()).toBe(stopped);
      handlers.stopRestartRetries();
    },
  );

  it("skips neutral refreshes unless a superseded auth refresh is still pending", async () => {
    const { handlers, requestRecoveryRestart } = createHandlers();
    const neutralPlan = buildGatewayReloadPlan(["agents.entries.alpha.name"]);
    await expect(handlers.applyHotReload(neutralPlan, {}, publicationFor({}))).resolves.toBe(
      "applied",
    );
    expect(hoisted.refreshes).toHaveLength(0);
    expect(hoisted.staleScopes).toHaveLength(0);

    const supersession = new AbortController();
    const first = handlers.applyHotReload(
      agentPlan("beta"),
      {},
      publicationFor({}, supersession.signal),
    );
    const pending = await waitForRefreshCount(1);
    supersession.abort();
    await first;

    const successor = handlers.applyHotReload(neutralPlan, {}, publicationFor({}));
    const refresh = await waitForRefreshCount(2);
    expect(refresh.agentIds).toEqual(new Set(["alpha", "beta"]));
    expect(hoisted.staleScopes.at(-1)).toEqual(new Set(["alpha", "beta"]));
    refresh.settle.resolve();
    await expect(successor).resolves.toBe("applied");
    pending.settle.resolve();
    await pending.settle.promise;
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "stops a stale reload's model refresh and applies the newer write with both scopes (retained services: %s)",
    { timeout: 10_000 },
    async (withRetainedServices) => {
      const initialConfig = {
        gateway: { reload: {} },
        agents: { entries: { main: {} } },
      } as OpenClawConfig;
      const configA = {
        gateway: { reload: {} },
        agents: { entries: { main: {}, alpha: { name: "alpha" } } },
      } as OpenClawConfig;
      const configB = {
        gateway: { reload: {} },
        agents: { entries: { main: {}, alpha: { name: "Alpha" }, beta: { name: "Beta" } } },
      } as OpenClawConfig;
      const reloadPluginServices = vi.fn(async () => {});
      const { handlers, logReload, requestRecoveryRestart } = createHandlers(undefined, {
        reloadPluginServices,
      });
      setRuntimeConfigSnapshot(initialConfig, initialConfig);
      const committed: OpenClawConfig[] = [];
      const onHotReload = async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
        sourceConfig: OpenClawConfig,
      ) => {
        return await handlers.applyHotReload(plan, nextConfig, {
          sourceConfig,
          isCurrent: ownership.isCurrent,
          checkpoint: ownership.checkpoint,
          ...(ownership.supersededSignal ? { supersededSignal: ownership.supersededSignal } : {}),
          publish: async (commit, isCommitted) => {
            await commit();
            if (isCommitted()) {
              committed.push(nextConfig);
              ownership.markRuntimeCommitted(nextConfig, plan);
            }
          },
        });
      };
      const harness = createWriteReloaderHarness({ initialConfig, onHotReload });
      await harness.reloader.ready;
      const write = (config: OpenClawConfig, hash: string, revision: number) =>
        harness.emitWrite({
          configPath: "/tmp/openclaw.json",
          sourceConfig: config,
          runtimeConfig: config,
          persistedHash: hash,
          snapshot: makeSnapshot({ config, hash }),
          revision,
          fingerprint: `runtime-${hash}`,
          sourceFingerprint: `source-${hash}`,
          writtenAtMs: Date.now(),
        } satisfies ConfigWriteNotification);

      if (withRetainedServices) {
        const apply = handlers.applyHotReload;
        handlers.applyHotReload = (plan, ...args) =>
          apply(
            args[0] === configA ? { ...plan, restartServices: new Set(["retained"]) } : plan,
            ...args,
          );
      }
      write(configA, "roster-a", 1);
      const refreshA = await waitForRefreshCount(1);
      expect(refreshA.config).toBe(configA);
      expect(refreshA.agentIds).toEqual(new Set(["alpha"]));

      write(configB, "patch-b", 2);
      const refreshB = await waitForRefreshCount(2);

      expect(refreshB.config).toBe(configB);
      expect(refreshB.agentIds).toEqual(new Set(["alpha", "beta"]));
      expect(hoisted.staleScopes.at(-1)).toEqual(new Set(["alpha", "beta"]));
      expect(committed).toEqual([configA, configB]);

      refreshB.settle.resolve();
      await waitForReloadState(() => !harness.reloader.isReloading());
      expect(harness.onConfigRevisionApplied.mock.calls.map(([hash]) => hash)).toEqual([
        hashRuntimeConfigValue(configA),
        hashRuntimeConfigValue(configB),
      ]);
      expect(harness.onConfigAccepted).toHaveBeenCalledTimes(1);
      expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toBe(configB);
      if (withRetainedServices) {
        expect(reloadPluginServices).toHaveBeenCalledExactlyOnceWith(
          configB,
          new Set(["retained"]),
        );
      }
      expect(harness.log.info).toHaveBeenCalledWith(
        expect.stringContaining("config reload superseded"),
      );
      refreshA.settle.reject(new Error("stale build failed"));
      await expect(refreshA.settle.promise).rejects.toThrow("stale build failed");
      expect(logReload.info).toHaveBeenCalledWith(
        "superseded prepared model runtime refresh ended after a newer reload took its scope: stale build failed",
      );
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      await harness.reloader.stop();

      setRuntimeConfigSnapshot({}, {});
      const third = handlers.applyHotReload(agentPlan("gamma"), {}, publicationFor({}));
      const unrelatedRefresh = await waitForRefreshCount(3);
      expect(unrelatedRefresh.agentIds).toEqual(new Set(["gamma"]));
      unrelatedRefresh.settle.resolve();
      await third;
    },
  );

  it("signals supersession for a newer write but not for a watcher observation", async () => {
    const initialConfig = { gateway: { reload: {} } } satisfies OpenClawConfig;
    const configA = { gateway: { reload: {} }, hooks: { path: "/a" } } as OpenClawConfig;
    const configB = { gateway: { reload: {} }, hooks: { path: "/b" } } as OpenClawConfig;
    const signals: AbortSignal[] = [];
    const releaseTail = createDeferred();
    const onConfigCandidateObserved = vi.fn();
    const harness = createWriteReloaderHarness({
      initialConfig,
      onConfigCandidateObserved,
      onHotReload: async (plan, nextConfig, ownership) => {
        ownership.markRuntimeCommitted(nextConfig, plan);
        if (nextConfig === configA) {
          signals.push(ownership.supersededSignal!);
          await releaseTail.promise;
        }
        return "applied" as const;
      },
    });
    await harness.reloader.ready;
    const write = (config: OpenClawConfig, hash: string, revision: number) =>
      harness.emitWrite({
        configPath: "/tmp/openclaw.json",
        sourceConfig: config,
        runtimeConfig: config,
        persistedHash: hash,
        snapshot: makeSnapshot({ config, hash }),
        revision,
        fingerprint: `runtime-${hash}`,
        sourceFingerprint: `source-${hash}`,
        writtenAtMs: Date.now(),
      } satisfies ConfigWriteNotification);

    write(configA, "hooks-a", 1);
    await waitForReloadState(() => signals.length === 1);
    const observations = onConfigCandidateObserved.mock.calls.length;
    harness.watcher.emit("change");
    expect(onConfigCandidateObserved).toHaveBeenCalledTimes(observations + 1);
    expect(signals[0]?.aborted).toBe(false);

    write(configB, "hooks-b", 2);
    expect(signals[0]?.aborted).toBe(true);
    releaseTail.resolve();
    await waitForReloadState(() =>
      harness.onConfigAccepted.mock.calls.some(([config]) => config === configB),
    );
    await harness.reloader.stop();
  });

  it("keeps awaiting the model refresh without a superseding source", async () => {
    const { handlers, logReload } = createHandlers();
    const signal = new AbortController().signal;
    let applied = false;
    const reload = handlers
      .applyHotReload(agentPlan("alpha"), {}, publicationFor({}, signal))
      .then(() => {
        applied = true;
      });
    const refresh = await waitForRefreshCount(1);
    expect(applied).toBe(false);

    refresh.settle.resolve();
    await reload;
    expect(logReload.info).toHaveBeenCalledWith(
      "config hot reload applied (agents.entries.alpha.model)",
    );
  });

  it("widens the successor to a full refresh when the handed-off scope was full", async () => {
    const { handlers } = createHandlers();
    const supersession = new AbortController();
    const first = handlers.applyHotReload(
      createHotTailPlan({ changedPaths: ["models"], hotReasons: ["models"] }),
      {},
      publicationFor({}, supersession.signal),
    );
    await waitForRefreshCount(1);
    supersession.abort();
    await first;

    const second = handlers.applyHotReload(agentPlan("beta"), {}, publicationFor({}));
    const successorRefresh = await waitForRefreshCount(2);
    expect(successorRefresh.agentIds).toBeUndefined();
    successorRefresh.settle.resolve();
    await second;
  });

  it("drops the handed-off scope once the detached refresh publishes on its own", async () => {
    const { handlers } = createHandlers();
    const supersession = new AbortController();
    const first = handlers.applyHotReload(
      agentPlan("alpha"),
      {},
      publicationFor({}, supersession.signal),
    );
    const detached = await waitForRefreshCount(1);
    supersession.abort();
    await first;
    detached.settle.resolve();
    await detached.settle.promise;

    const second = handlers.applyHotReload(agentPlan("beta"), {}, publicationFor({}));
    const successorRefresh = await waitForRefreshCount(2);
    expect(successorRefresh.agentIds).toEqual(new Set(["beta"]));
    successorRefresh.settle.resolve();
    await second;
  });

  it("recovers a handed-off refresh that fails before any successor takes its scope", async () => {
    const { handlers, requestRecoveryRestart } = createHandlers();
    const supersession = new AbortController();
    const first = handlers.applyHotReload(
      agentPlan("alpha"),
      {},
      publicationFor({}, supersession.signal),
    );
    const detached = await waitForRefreshCount(1);
    supersession.abort();
    await first;
    handlers.recordAcceptedRestartTarget({
      runtimeConfig: {},
      sourceConfig: {},
      prepareRuntimeConfig: async () => ({}),
    });

    detached.settle.reject(new Error("model runtime build failed"));

    await vi.waitFor(() =>
      expect(requestRecoveryRestart).toHaveBeenCalledWith(
        "config reload: hot reload recovery: prepared model runtime reload",
        undefined,
      ),
    );
    handlers.stopRestartRetries();
  });

  it("hands off a context window refresh that is still loading when superseded", async () => {
    const { handlers, logReload } = createHandlers();
    const supersession = new AbortController();
    const contextLoad = createDeferred();
    const contextStarted = createDeferred();
    hoisted.refreshContextWindowCache.mockImplementationOnce(() => {
      contextStarted.resolve();
      return contextLoad.promise;
    });
    const reload = handlers.applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      }),
      {},
      publicationFor({}, supersession.signal),
    );
    (await waitForRefreshCount(1)).settle.resolve();
    await contextStarted.promise;
    supersession.abort();

    await expect(reload).resolves.toBe("applied");
    expect(logReload.info).toHaveBeenCalledWith(
      "config hot reload committed and superseded; context window cache convergence continues under the newer config (agents.defaults.workspace)",
    );
    contextLoad.resolve();
  });
});
