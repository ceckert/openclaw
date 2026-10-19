import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import type {
  GatewayConfigReloaderOptions,
  GatewayConfigReloadTransactionOwnership,
} from "./config-reload.types.js";

type SourcePublication = Awaited<
  ReturnType<NonNullable<GatewayConfigReloaderOptions["onEffectiveConfigUnchanged"]>>
>;

export function createConfigReloadSourcePublication(params: {
  opts: GatewayConfigReloaderOptions;
  changedPaths: readonly string[];
  pluginLifecycle: GatewayReloadPlan["pluginLifecycle"];
  nextConfig: OpenClawConfig;
  ownership: GatewayConfigReloadTransactionOwnership;
  sourceConfig: OpenClawConfig;
}) {
  let published: SourcePublication | undefined;
  const baselineOnly =
    params.changedPaths.length === 0 &&
    !params.pluginLifecycle &&
    !params.opts.hasDeferredHotReload?.();
  const handler = params.opts.onEffectiveConfigUnchanged;
  return {
    baselineOnly,
    publish:
      baselineOnly && handler
        ? async () => {
            published ??= await handler(params.nextConfig, params.ownership, params.sourceConfig);
          }
        : undefined,
    isPublished: () => published !== undefined,
    rollback: async () => await published?.rollback(),
    commit: () => published?.commit?.(),
  };
}
