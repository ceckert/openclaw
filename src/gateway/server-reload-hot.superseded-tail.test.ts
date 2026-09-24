// A committed hot reload hands its slow prepared-model-runtime tail to the newer
// config's reload instead of finishing a runtime refresh that is already stale.
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { ConfigWriteNotification } from "../config/config.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireActivePluginChannelRegistry } from "../plugins/runtime.js";
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
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

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

vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: vi.fn(),
  markPreparedModelRuntimeSnapshotsStale: (
    _reason?: string,
    options?: { agentIds?: ReadonlySet<string> },
  ) => {
    hoisted.staleScopes.push(options?.agentIds);
    return Symbol("replacement-gate");
  },
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: async (
    config: OpenClawConfig,
    options: { agentIds?: ReadonlySet<string> },
  ) => {
    const settle = createDeferred();
    hoisted.refreshes.push({ config, agentIds: options.agentIds, settle });
    await settle.promise;
  },
}));

vi.mock("../agents/context.js", () => ({
  refreshContextWindowCache: (config: OpenClawConfig) => hoisted.refreshContextWindowCache(config),
}));

vi.mock("../hooks/loader.js", () => ({
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
  hoisted.refreshes.length = 0;
  hoisted.staleScopes.length = 0;
  hoisted.refreshContextWindowCache.mockReset().mockResolvedValue(undefined);
});

afterEach(closeTestConfigReloaders);

function createHandlers(requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }))) {
  let state = createDefaultGatewayReloadState();
  const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = createGatewayReloadHandlers({
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
  } as never);
  return { handlers, logReload, requestRecoveryRestart };
}

function agentPlan(...agentIds: string[]): GatewayReloadPlan {
  return buildGatewayReloadPlan(agentIds.map((id) => `agents.entries.${id}.name`));
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
  it(
    "stops a stale reload's model refresh and applies the newer write with both scopes",
    { timeout: 10_000 },
    async () => {
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
      const { handlers } = createHandlers();
      const committed: OpenClawConfig[] = [];
      const reloadDurations: number[] = [];
      const onHotReload = async (
        plan: GatewayReloadPlan,
        nextConfig: OpenClawConfig,
        ownership: GatewayConfigReloadTransactionOwnership,
        sourceConfig: OpenClawConfig,
      ) => {
        const startedAt = performance.now();
        try {
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
        } finally {
          reloadDurations.push(performance.now() - startedAt);
        }
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

      write(configA, "roster-a", 1);
      const refreshA = await waitForRefreshCount(1);
      expect(refreshA.config).toBe(configA);
      expect(refreshA.agentIds).toEqual(new Set(["alpha"]));

      const supersededAt = performance.now();
      write(configB, "patch-b", 2);
      const refreshB = await waitForRefreshCount(2);
      const handoffMs = performance.now() - supersededAt;

      expect(refreshB.config).toBe(configB);
      expect(refreshB.agentIds).toEqual(new Set(["alpha", "beta"]));
      expect(committed).toEqual([configA, configB]);
      expect(handoffMs).toBeLessThan(1_000);
      expect(reloadDurations).toHaveLength(1);

      refreshB.settle.resolve();
      await waitForReloadState(() => !harness.reloader.isReloading());
      expect(harness.onConfigRevisionApplied.mock.calls.map(([hash]) => hash)).toEqual([
        hashRuntimeConfigValue(configA),
        hashRuntimeConfigValue(configB),
      ]);
      expect(harness.onConfigAccepted).toHaveBeenCalledTimes(1);
      expect(harness.onConfigAccepted.mock.calls[0]?.[0]).toBe(configB);
      expect(harness.log.info).toHaveBeenCalledWith(
        expect.stringContaining("config reload superseded"),
      );
      refreshA.settle.reject(new PreparedModelRuntimePublicationSupersededError("superseded"));
      await delay(0);
      await harness.reloader.stop();
    },
  );

  it("signals supersession for a newer write but not for a watcher observation", async () => {
    const initialConfig = { gateway: { reload: {} } } satisfies OpenClawConfig;
    const configA = { gateway: { reload: {} }, hooks: { path: "/a" } } as OpenClawConfig;
    const configB = { gateway: { reload: {} }, hooks: { path: "/b" } } as OpenClawConfig;
    const signals: AbortSignal[] = [];
    const releaseTail = createDeferred();
    const harness = createWriteReloaderHarness({
      initialConfig,
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
    harness.watcher.emit("change");
    await delay(10);
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
    await delay(10);
    expect(applied).toBe(false);

    refresh.settle.resolve();
    await reload;
    expect(logReload.info).toHaveBeenCalledWith(
      "config hot reload applied (agents.entries.alpha.name)",
    );
  });

  it("returns once superseded and widens the next reload's scope with the unfinished one", async () => {
    const { handlers, logReload } = createHandlers();
    const supersession = new AbortController();
    const first = handlers.applyHotReload(
      agentPlan("alpha"),
      { agents: { entries: { alpha: {} } } } as OpenClawConfig,
      publicationFor({}, supersession.signal),
    );
    const staleRefresh = await waitForRefreshCount(1);
    supersession.abort();

    await expect(first).resolves.toBe("applied");
    expect(logReload.info).toHaveBeenCalledWith(
      "config hot reload committed and superseded; prepared model runtime and context window cache convergence continues under the newer config (agents.entries.alpha.name)",
    );

    const second = handlers.applyHotReload(agentPlan("beta"), {}, publicationFor({}));
    const successorRefresh = await waitForRefreshCount(2);
    expect(hoisted.staleScopes.at(-1)).toEqual(new Set(["alpha", "beta"]));
    expect(successorRefresh.agentIds).toEqual(new Set(["alpha", "beta"]));
    successorRefresh.settle.resolve();
    await second;
    staleRefresh.settle.reject(new Error("stale build failed"));
    await delay(0);

    const third = handlers.applyHotReload(agentPlan("gamma"), {}, publicationFor({}));
    const unrelatedRefresh = await waitForRefreshCount(3);
    expect(unrelatedRefresh.agentIds).toEqual(new Set(["gamma"]));
    unrelatedRefresh.settle.resolve();
    await third;
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
    await delay(0);

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
    hoisted.refreshContextWindowCache.mockReturnValueOnce(contextLoad.promise);
    const reload = handlers.applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      }),
      {},
      publicationFor({}, supersession.signal),
    );
    (await waitForRefreshCount(1)).settle.resolve();
    await vi.waitFor(() => expect(hoisted.refreshContextWindowCache).toHaveBeenCalledOnce());
    supersession.abort();

    await expect(reload).resolves.toBe("applied");
    expect(logReload.info).toHaveBeenCalledWith(
      "config hot reload committed and superseded; context window cache convergence continues under the newer config (agents.defaults.workspace)",
    );
    contextLoad.resolve();
  });
});
