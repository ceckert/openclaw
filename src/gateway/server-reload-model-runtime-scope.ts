import { refreshContextWindowCache } from "../agents/context.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import {
  refreshPreparedModelRuntimeSnapshots,
  rejectPendingPreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
} from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import { settleUnlessSuperseded } from "./server-reload-utils.js";

/** Returns affected agent ids when every meaningful reload path is agent-entry-local. */
export function resolveReloadAgentIds(
  changedPaths: readonly string[],
): ReadonlySet<string> | undefined {
  if (changedPaths.length === 0) {
    return undefined;
  }
  const agentIds = new Set<string>();
  for (const path of changedPaths) {
    if (path === "meta" || path.startsWith("meta.")) {
      continue;
    }
    const match = /^agents\.entries\.([^.]+)(?:\.|$)/.exec(path);
    if (!match?.[1]) {
      return undefined;
    }
    agentIds.add(normalizeAgentId(match[1]));
  }
  return agentIds.size > 0 ? agentIds : undefined;
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

/** Carries a superseded committed reload's unfinished refresh scope to its successor. */
export function createDeferredModelRuntimeRefresh() {
  let deferred: { agentIds: ReadonlySet<string> | undefined } | undefined;
  const services = new Set<string>();
  const defer = (params: {
    agentIds: ReadonlySet<string> | undefined;
    refresh: Promise<void>;
    log: { info: (message: string) => void; warn: (message: string) => void };
    onFailure: (error: unknown) => void;
  }) => {
    const debt = { agentIds: params.agentIds };
    deferred = debt;
    void params.refresh.then(
      () => {
        if (deferred === debt) {
          deferred = undefined;
        }
      },
      (err: unknown) => {
        if (deferred !== debt) {
          params.log.info(
            `superseded prepared model runtime refresh ended after a newer reload took its scope: ${formatErrorMessage(err)}`,
          );
          return;
        }
        if (err instanceof PreparedModelRuntimePublicationSupersededError) {
          params.log.warn(
            `superseded prepared model runtime refresh was replaced; the next config reload rebuilds its scope: ${formatErrorMessage(err)}`,
          );
          return;
        }
        params.onFailure(err);
      },
    );
  };
  return {
    hasPending: () => deferred !== undefined || services.size > 0,
    widenServices: (ids: Set<string> | undefined) =>
      services.size > 0 ? new Set([...services, ...(ids ?? [])]) : ids,
    clearServices: () => services.clear(),
    widen: (planAgentIds: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined => {
      if (!deferred) {
        return planAgentIds;
      }
      return planAgentIds && deferred.agentIds
        ? new Set([...planAgentIds, ...deferred.agentIds])
        : undefined;
    },
    refresh: async (params: {
      config: OpenClawConfig;
      agentIds: ReadonlySet<string> | undefined;
      pluginRegistry: PluginRegistry;
      getPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
      supersededSignal: AbortSignal | undefined;
      log: { info: (message: string) => void; warn: (message: string) => void };
      onFailure: (error: unknown) => void;
      serviceIds: ReadonlySet<string> | undefined;
      reloadServices: () => Promise<void>;
    }) => {
      const refresh = withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        refreshModelRuntimeAfterHotReload({
          config: params.config,
          agentIds: params.agentIds,
          pluginMetadataSnapshot: params.getPluginMetadataSnapshot(),
        }),
      );
      deferred = undefined;
      let outcome: Awaited<ReturnType<typeof settleUnlessSuperseded>> | undefined;
      try {
        outcome = await settleUnlessSuperseded(refresh, params.supersededSignal);
        if (outcome === "superseded") {
          defer({ ...params, refresh });
          for (const id of params.serviceIds ?? []) {
            services.add(id);
          }
        }
        return outcome;
      } finally {
        if (outcome !== "superseded") {
          await params.reloadServices();
        }
      }
    },
  };
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
    if (!services?.size || !params.isCurrent()) {
      return;
    }
    params.onStart();
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

export async function recoverModelRuntimeAfterPluginFailure(params: {
  handler: GatewayReloadHandlerParams;
  config: OpenClawConfig;
  agentIds: ReadonlySet<string> | undefined;
  isCurrent: () => boolean;
  gateId: PreparedModelRuntimeReplacementGateId | undefined;
  error: PluginRuntimeApplicationError;
}) {
  try {
    await withPluginRuntimeRegistryScope(params.handler.getPluginRegistry(), () =>
      refreshModelRuntimeAfterHotReload({
        config: params.config,
        agentIds: params.agentIds,
        pluginMetadataSnapshot: params.handler.getPluginMetadataSnapshot?.(),
        isPublicationCurrent: params.isCurrent,
      }),
    );
  } catch (refreshError) {
    rejectPendingPreparedModelRuntimeReplacement(params.gateId, refreshError);
    throw new PluginRuntimeApplicationError(
      `Plugin model/reply recovery failed: ${formatErrorMessage(refreshError)}. Retry the plugin reload or restart the Gateway. Original failure: ${formatErrorMessage(params.error)}`,
      params.error.details,
      {
        cause: new AggregateError(
          [params.error, refreshError],
          "Plugin model/reply recovery failed",
        ),
      },
    );
  }
}

export async function refreshContextWindowCacheUnlessSuperseded(params: {
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
) {
  const handedOff: string[] = [];
  return {
    handedOff,
    scheduleDetachedRecovery: (surface: string, error: unknown) => {
      try {
        scheduleRecoveryRestart(surface, error);
      } catch (recoveryError) {
        log.warn(
          `${surface} failed after config supersession: ${formatErrorMessage(recoveryError)}`,
        );
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
