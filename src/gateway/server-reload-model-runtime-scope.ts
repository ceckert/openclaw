import { listAgentIds } from "../agents/agent-roster.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { refreshContextWindowCache } from "../agents/context.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import { pruneRemovedProviderPluginModelCatalogs } from "../agents/plugin-model-catalog.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { diffConfigPaths } from "./config-diff.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import {
  doesReloadAffectPluginCapabilities,
  doesReloadAffectProviderAuth,
  isProviderAuthRelevantReloadPath,
  shouldRefreshContextWindowCache,
} from "./config-reload-recovery.js";
import type { GatewayHotReloadApplication } from "./config-reload-status.types.js";
import type {
  GatewayHotReloadPublication,
  GatewayPluginReloadResult,
  GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
import { settleUnlessSuperseded } from "./server-reload-utils.js";

export function resolveHotReloadApplication(
  restartRequired: boolean,
  modelRuntimeSuperseded: boolean,
  runtime?: GatewayPluginReloadResult["runtime"],
): GatewayHotReloadApplication {
  const status = restartRequired
    ? "applied-restart-required"
    : modelRuntimeSuperseded
      ? "superseded"
      : "applied";
  return runtime ? { status, runtime } : status;
}

/** Retains unfinished model preparation across superseding config publications. */
export function createGatewayModelRuntimeReload() {
  let pending: { config: OpenClawConfig; sourceConfig: OpenClawConfig } | undefined;
  let currentAttempt: symbol | undefined;
  const services = new Set<string>();
  return {
    hasPending: () => pending !== undefined || services.size > 0,
    widenServices: (ids: Set<string> | undefined) =>
      services.size > 0 ? new Set([...services, ...(ids ?? [])]) : ids,
    clearServices: () => services.clear(),
    prepare(plan: GatewayReloadPlan, previousConfig: OpenClawConfig, nextConfig: OpenClawConfig) {
      const attempt = Symbol("model-runtime-reload");
      currentAttempt = attempt;
      const baseline = pending ?? {
        config: previousConfig,
        sourceConfig: projectConfigOntoRuntimeSourceSnapshot(previousConfig),
      };
      const agentIds = doesReloadAffectPluginCapabilities(plan, baseline.config, nextConfig)
        ? undefined
        : resolveReloadAgentIds([
            ...plan.changedPaths,
            ...diffConfigPaths(baseline.config, nextConfig),
          ]);
      const complete = () => {
        if (currentAttempt === attempt) {
          pending = undefined;
        }
      };
      const defer = (serviceIds: ReadonlySet<string> | undefined = plan.restartServices) => {
        pending ??= baseline;
        for (const id of serviceIds ?? []) {
          services.add(id);
        }
      };
      return {
        required:
          pending !== undefined ||
          services.size > 0 ||
          doesReloadAffectProviderAuth(plan, previousConfig, nextConfig),
        refreshContextWindows: pending !== undefined || shouldRefreshContextWindowCache(plan),
        agentIds,
        scope: agentIds ? { agentIds } : {},
        sourceConfig: baseline.sourceConfig,
        complete,
        defer,
        refresh: async (params: {
          config: OpenClawConfig;
          nextSourceConfig: OpenClawConfig;
          pluginRegistry: PluginRegistry;
          getPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
          publication: GatewayHotReloadPublication | undefined;
          log: { info: (message: string) => void; warn: (message: string) => void };
          onFailure: (error: unknown) => void;
          serviceIds: ReadonlySet<string> | undefined;
          reloadServices: () => Promise<void>;
        }) => {
          const supersededSignal = params.publication?.supersededSignal;
          const refresh = withPluginRuntimeRegistryScope(params.pluginRegistry, async () => {
            await pruneRemovedProviderModelCatalogs(baseline.sourceConfig, params.nextSourceConfig);
            await refreshModelRuntimeAfterHotReload({
              config: params.config,
              agentIds,
              pluginMetadataSnapshot: params.getPluginMetadataSnapshot(),
            });
          });
          let outcome: Awaited<ReturnType<typeof settleUnlessSuperseded>> | undefined;
          try {
            outcome = await settleUnlessSuperseded(refresh, supersededSignal);
            if (outcome === "superseded") {
              defer(params.serviceIds);
              void refresh.then(
                () => {
                  if (services.size === 0) {
                    complete();
                  }
                },
                (error: unknown) => {
                  if (currentAttempt !== attempt) {
                    params.log.info(
                      `superseded prepared model runtime refresh ended after a newer reload took its scope: ${formatErrorMessage(error)}`,
                    );
                  } else if (error instanceof PreparedModelRuntimePublicationSupersededError) {
                    params.log.warn(
                      `superseded prepared model runtime refresh was replaced; the next config reload rebuilds its scope: ${formatErrorMessage(error)}`,
                    );
                  } else {
                    params.onFailure(error);
                  }
                },
              );
            } else {
              complete();
            }
            return outcome;
          } finally {
            if (outcome !== "superseded" && !supersededSignal?.aborted) {
              await params.reloadServices();
            }
          }
        },
      };
    },
  };
}

/** Returns agent-local model/auth changes; undefined requires a global refresh. */
function resolveReloadAgentIds(changedPaths: readonly string[]): ReadonlySet<string> | undefined {
  const agentIds = new Set<string>();
  for (const path of changedPaths) {
    if (!isProviderAuthRelevantReloadPath(path)) {
      continue;
    }
    const match = /^agents\.entries\.([^.]+)(?:\.|$)/.exec(path);
    if (!match?.[1]) {
      return undefined;
    }
    agentIds.add(normalizeAgentId(match[1]));
  }
  return agentIds;
}

/** Apply known endpoint removals before publishing the replacement model inventory. */
async function pruneRemovedProviderModelCatalogs(
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): Promise<void> {
  const previousProviders = normalizeProviderMapKeys(previousConfig.models?.providers);
  const nextProviders = normalizeProviderMapKeys(nextConfig.models?.providers);
  const removedProviderBaseUrls = Object.fromEntries(
    Object.entries(previousProviders).flatMap(([id, provider]) =>
      provider.baseUrl && !Object.hasOwn(nextProviders, id) ? [[id, provider.baseUrl]] : [],
    ),
  );
  if (Object.keys(removedProviderBaseUrls).length === 0) {
    return;
  }
  const agentDirs = new Set(
    listAgentIds(previousConfig).map((id) => resolveAgentDir(previousConfig, id)),
  );
  for (const agentDir of agentDirs) {
    await pruneRemovedProviderPluginModelCatalogs({ agentDir, removedProviderBaseUrls });
  }
}

export function refreshModelRuntimeAfterHotReload(params: {
  config: OpenClawConfig;
  agentIds: ReadonlySet<string> | undefined;
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  isPublicationCurrent?: () => boolean;
}): Promise<void> {
  return refreshPreparedModelRuntimeSnapshots(params.config, {
    catalogMode: "static",
    joinSupersedingPublication: true,
    ...(params.isPublicationCurrent ? { isPublicationCurrent: params.isPublicationCurrent } : {}),
    allowGatewaySubagentBinding: true,
    ...(params.agentIds ? { agentIds: params.agentIds } : {}),
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
  });
}

export function createScopedModelRuntimeRefresh(params: {
  handler: Pick<GatewayReloadHandlerParams, "getPluginRegistry" | "getPluginMetadataSnapshot">;
  agentIds: ReadonlySet<string> | undefined;
}) {
  return (config: OpenClawConfig, isPublicationCurrent?: () => boolean) =>
    withPluginRuntimeRegistryScope(params.handler.getPluginRegistry(), () =>
      refreshModelRuntimeAfterHotReload({
        config,
        agentIds: params.agentIds,
        pluginMetadataSnapshot: params.handler.getPluginMetadataSnapshot?.(),
        ...(isPublicationCurrent ? { isPublicationCurrent } : {}),
      }),
    );
}

export function createRetainedPluginServiceReload(params: {
  handler: GatewayReloadHandlerParams;
  config: OpenClawConfig;
  serviceIds: () => ReadonlySet<string> | undefined;
  isCurrent: () => boolean;
  onStart: () => void;
}) {
  return async () => {
    const services = params.serviceIds();
    if (!params.isCurrent()) {
      return;
    }
    params.onStart();
    if (!services?.size) {
      return;
    }
    try {
      if (!params.handler.reloadPluginServices) {
        throw new Error("Plugin service reload owner is unavailable");
      }
      await params.handler.reloadPluginServices(params.config, services);
    } catch (error) {
      params.handler.logReload.warn(`plugin services reload failed: ${formatErrorMessage(error)}`);
    }
  };
}

async function refreshContextWindowCacheUnlessSuperseded(params: {
  config: OpenClawConfig;
  supersededSignal: AbortSignal | undefined;
  onFailure: (error: unknown) => void;
}) {
  const refresh = refreshContextWindowCache(params.config);
  const outcome = await settleUnlessSuperseded(refresh, params.supersededSignal);
  if (outcome === "superseded") {
    void refresh.catch(params.onFailure);
  }
  return outcome;
}

export function createModelRuntimeReloadTail(
  plan: GatewayReloadPlan,
  log: GatewayReloadHandlerParams["logReload"],
  scheduleRecoveryRestart: (surface: string, error: unknown) => void,
  refreshContextWindows = shouldRefreshContextWindowCache(plan),
) {
  const handedOff: string[] = [];
  const scheduleDetachedRecovery = (surface: string, error: unknown) => {
    try {
      scheduleRecoveryRestart(surface, error);
    } catch (recoveryError) {
      log.warn(`${surface} failed after config supersession: ${formatErrorMessage(recoveryError)}`);
    }
  };
  return {
    handedOff,
    scheduleDetachedRecovery,
    refreshContextWindowCache: async (
      config: OpenClawConfig,
      supersededSignal: AbortSignal | undefined,
    ) => {
      if (!refreshContextWindows) {
        return;
      }
      try {
        if (
          (await refreshContextWindowCacheUnlessSuperseded({
            config,
            supersededSignal,
            onFailure: (error) => scheduleDetachedRecovery("context window cache reload", error),
          })) === "superseded"
        ) {
          handedOff.push("context window cache");
        }
      } catch (error) {
        scheduleRecoveryRestart("context window cache reload", error);
      }
    },
    logApplication: () => {
      if (handedOff.length > 0) {
        log.info(
          `config hot reload committed and superseded; ${handedOff.join(" and ")} convergence continues under the newer config (${plan.changedPaths.join(", ")})`,
        );
      } else if (plan.hotReasons.length > 0) {
        log.info(`config hot reload applied (${plan.hotReasons.join(", ")})`);
      } else if (plan.noopPaths.length > 0) {
        log.info(`config change applied (dynamic reads: ${plan.noopPaths.join(", ")})`);
      }
    },
  };
}
