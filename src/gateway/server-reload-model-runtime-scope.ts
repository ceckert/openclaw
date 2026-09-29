import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../routing/session-key.js";

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
  return {
    hasPending: () => deferred !== undefined,
    widen: (planAgentIds: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined => {
      if (!deferred) {
        return planAgentIds;
      }
      return planAgentIds && deferred.agentIds
        ? new Set([...planAgentIds, ...deferred.agentIds])
        : undefined;
    },
    take: () => {
      deferred = undefined;
    },
    defer: (params: {
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
    },
  };
}
