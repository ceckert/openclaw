// Resolves config and metadata before publishing prepared plugin runtime load facts.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import { hashStableJson } from "../installed-plugin-index-hash.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "../plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../registry-types.js";
import type { PluginLogger } from "../types.js";
import {
  createPluginRuntimeLoaderLogger,
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./load-context.js";

/** Options accepted while resolving plugin runtime load context. */
type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
  expectedSourceDigests?: PluginRuntimeLoadContext["expectedSourceDigests"];
};

/** Resolves config, manifests, install records, and auto-enable state for runtime loads. */
export function resolvePluginRuntimeLoadContext(
  options?: PluginRuntimeLoadContextOptions,
): PluginRuntimeLoadContext {
  const env = options?.env ?? process.env;
  const rawConfig = options?.config ?? getRuntimeConfig();
  const rawWorkspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const metadataSnapshot =
    options?.metadataSnapshot ??
    (options?.manifestRegistry !== undefined
      ? undefined
      : options?.workspaceDir === undefined
        ? projectPluginMetadataSnapshot(
            resolveConfigWidePluginMetadataSnapshot({ config: rawConfig, env }),
            options?.onlyPluginIds,
          )
        : resolvePluginMetadataSnapshot({
            config: rawConfig,
            env,
            workspaceDir: rawWorkspaceDir,
            allowWorkspaceScopedCurrent: true,
            ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
          }));
  const manifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const autoEnabled = applyPluginAutoEnable({
    config: rawConfig,
    env,
    manifestRegistry,
    discovery: metadataSnapshot?.discovery,
  });
  const config = autoEnabled.config;
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(manifestRegistry ? { manifestRegistry } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    installRecords,
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts,
    expectedSourceDigests: options?.expectedSourceDigests,
  };
}

function samePluginActivation(
  previous: PluginRuntimeLoadContext,
  next: PluginRuntimeLoadContext,
): boolean {
  return (
    hashStableJson(previous.config.plugins) === hashStableJson(next.config.plugins) &&
    hashStableJson(previous.activationSourceConfig.plugins) ===
      hashStableJson(next.activationSourceConfig.plugins) &&
    hashStableJson(previous.autoEnabledReasons) === hashStableJson(next.autoEnabledReasons)
  );
}

/** Advances a loaded registry's activation stamp to a committed config that keeps its activation. */
export function advancePluginRuntimeLoadContextConfig(
  registry: PluginRegistry | undefined,
  config: OpenClawConfig,
  activationSourceConfig: OpenClawConfig,
): boolean {
  const context = getPluginRuntimeLoadContext(registry);
  if (!registry || !context?.metadataSnapshot) {
    return false;
  }
  const next = resolvePluginRuntimeLoadContext({
    config,
    activationSourceConfig,
    env: context.env,
    workspaceDir: context.workspaceDir,
    logger: context.logger,
    metadataSnapshot: context.metadataSnapshot,
    preferBuiltPluginArtifacts: context.preferBuiltPluginArtifacts,
    expectedSourceDigests: context.expectedSourceDigests,
  });
  if (!samePluginActivation(context, next)) {
    return false;
  }
  setPluginRuntimeLoadContext(registry, {
    ...next,
    workspaceDir: context.workspaceDir,
    manifestRegistry: context.manifestRegistry,
    installRecords: context.installRecords,
  });
  return true;
}
