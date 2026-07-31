/** Prepares secrets runtime snapshots from config, auth stores, plugins, and env. */
import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { secretRefKey } from "./ref-contract.js";
import {
  canUseSecretsRuntimeFastPath,
  collectCandidateAgentDirs,
  createEmptyRuntimeWebToolsMetadata,
  mergeSecretsRuntimeEnv,
  resolveRefreshAgentDirs,
} from "./runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot as clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeEnv as getActiveSecretsRuntimeEnvState,
  getActiveSecretsRuntimeRefreshContext,
  getActiveSecretsRuntimeSnapshot as getActiveSecretsRuntimeSnapshotState,
  getLiveSecretsRuntimeAuthStores,
  getPreparedSecretsRuntimeSnapshotRefreshContext,
  registerSecretsRuntimeStateClearHook,
  setPreparedSecretsRuntimeSnapshotRefreshContext,
  type PreparedSecretsRuntimeSnapshot,
  type SecretsRuntimeRefreshContext,
} from "./runtime-state.js";
import { getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState } from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

export type { SecretResolverWarning } from "./runtime-shared.js";
export type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

registerSecretsRuntimeStateClearHook(clearRuntimeAuthProfileStoreSnapshots);

const loadRuntimeManifestHelpers = createLazyRuntimeModule(
  () => import("./runtime-manifest.runtime.js"),
);

const loadRuntimePrepareHelpers = createLazyRuntimeModule(
  () => import("./runtime-prepare.runtime.js"),
);

async function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): Promise<ReadonlyMap<string, PluginOrigin>> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot =
    params.pluginMetadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config,
      workspaceDir,
      env: params.env,
    });
  return listPluginOriginsFromMetadataSnapshot(snapshot);
}

function providerAllowsResolvedRefReuse(config: OpenClawConfig, ref: SecretRef): boolean {
  const provider = config.secrets?.providers?.[ref.provider];
  return (
    ref.source === "exec" &&
    !(provider && typeof provider === "object" && "pluginIntegration" in provider)
  );
}

function collectReusableResolvedConfigRefs(params: {
  active: Pick<PreparedSecretsRuntimeSnapshot, "sourceConfig" | "resolvedRefValues"> | undefined;
  nextSourceConfig: OpenClawConfig;
}): Map<string, Promise<unknown>> {
  const active = params.active;
  if (
    !active ||
    !active.resolvedRefValues ||
    !isDeepStrictEqual(active.sourceConfig.secrets, params.nextSourceConfig.secrets)
  ) {
    return new Map();
  }

  const memo = new Map<string, Promise<unknown>>();
  const defaults = params.nextSourceConfig.secrets?.defaults;
  const visit = (source: unknown): void => {
    const ref = coerceSecretRef(source, defaults);
    if (ref) {
      const key = secretRefKey(ref);
      if (providerAllowsResolvedRefReuse(params.nextSourceConfig, ref)) {
        const resolved = active.resolvedRefValues?.get(key);
        if (active.resolvedRefValues?.has(key)) {
          memo.set(key, Promise.resolve(resolved));
        }
      }
      return;
    }
    if (Array.isArray(source)) {
      source.forEach((value) => visit(value));
      return;
    }
    if (source && typeof source === "object") {
      Object.values(source).forEach((value) => visit(value));
    }
  };
  visit(params.nextSourceConfig);
  return memo;
}

async function collectSuccessfulResolvedRefValues(
  resolvedByRefKey: Map<string, Promise<unknown>> | undefined,
): Promise<ReadonlyMap<string, unknown>> {
  if (!resolvedByRefKey || resolvedByRefKey.size === 0) {
    return new Map();
  }
  const entries = [...resolvedByRefKey.entries()];
  const settled = await Promise.allSettled(entries.map(([, value]) => value));
  const resolved = new Map<string, unknown>();
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      resolved.set(entries[index][0], result.value);
    }
  });
  return resolved;
}

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    Boolean(entries) &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    Boolean(channels) &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

function hasConfiguredPluginIntegrationSecretProviders(config: OpenClawConfig): boolean {
  const providers = config.secrets?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return false;
  }
  return Object.values(providers).some(
    (provider) =>
      provider?.source === "exec" &&
      "pluginIntegration" in provider &&
      provider.pluginIntegration !== undefined,
  );
}

function shouldLoadPluginMetadataForSecrets(config: OpenClawConfig): boolean {
  return (
    hasConfiguredPluginEntries(config) ||
    hasConfiguredChannelEntries(config) ||
    hasConfiguredPluginIntegrationSecretProviders(config)
  );
}

/** Prepares a secrets runtime snapshot and records refresh context for later activation. */
export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  reuseResolvedConfigRefsFrom?: Pick<
    PreparedSecretsRuntimeSnapshot,
    "sourceConfig" | "resolvedRefValues"
  >;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const fastPathLoadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
  const candidateDirs = params.agentDirs?.length
    ? uniqueStrings(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
  if (includeAuthStoreRefs) {
    for (const agentDir of candidateDirs) {
      authStores.push({
        agentDir,
        store: structuredClone(fastPathLoadAuthStore(agentDir)),
      });
    }
  }
  if (canUseSecretsRuntimeFastPath({ sourceConfig, authStores })) {
    const manifestRegistry =
      params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
    const snapshot = {
      sourceConfig,
      config: resolvedConfig,
      authStores,
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
      resolvedRefValues: new Map<string, unknown>(),
    };
    setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
      env: runtimeEnv,
      explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
      includeAuthStoreRefs,
      loadAuthStore: fastPathLoadAuthStore,
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
      ...(manifestRegistry ? { manifestRegistry } : {}),
    });
    return snapshot;
  }

  const {
    applyResolvedAssignments,
    collectAuthStoreAssignments,
    collectConfigAssignments,
    createResolverContext,
    resolveRuntimeWebTools,
    resolveSecretRefValues,
  } = await loadRuntimePrepareHelpers();
  const manifestRegistry =
    params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
  const loadablePluginOrigins =
    params.loadablePluginOrigins ??
    (shouldLoadPluginMetadataForSecrets(sourceConfig)
      ? await resolveLoadablePluginOrigins({
          config: sourceConfig,
          env: runtimeEnv,
          pluginMetadataSnapshot:
            params.pluginMetadataSnapshot ??
            (manifestRegistry ? { plugins: manifestRegistry.plugins } : undefined),
        })
      : new Map<string, PluginOrigin>());
  const context = createResolverContext({
    sourceConfig,
    env: runtimeEnv,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });
  context.cache.resolvedByRefKey = collectReusableResolvedConfigRefs({
    active: params.reuseResolvedConfigRefsFrom,
    nextSourceConfig: sourceConfig,
  });

  collectConfigAssignments({
    config: resolvedConfig,
    context,
    loadablePluginOrigins,
  });

  if (includeAuthStoreRefs) {
    const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
    if (!params.loadAuthStore) {
      authStores = candidateDirs.map((agentDir) => ({
        agentDir,
        store: structuredClone(loadAuthStore(agentDir)),
      }));
    }
    for (const entry of authStores) {
      collectAuthStoreAssignments({
        store: entry.store,
        context,
        agentDir: entry.agentDir,
      });
    }
  }

  if (context.assignments.length > 0) {
    const refs = context.assignments.map((assignment) => assignment.ref);
    const resolved = await resolveSecretRefValues(refs, {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
      manifestRegistry: context.manifestRegistry,
    });
    for (const value of resolved.values()) {
      if (typeof value === "string") {
        registerSecretValueForRedaction(value);
      }
    }
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  const webTools = await resolveRuntimeWebTools({
    sourceConfig,
    resolvedConfig,
    context,
  });
  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
    webTools,
    resolvedRefValues: await collectSuccessfulResolvedRefValues(context.cache.resolvedByRefKey),
  };
  setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
    env: runtimeEnv,
    explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
    includeAuthStoreRefs,
    loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
    loadablePluginOrigins,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });
  return snapshot;
}

/** Activates a prepared secrets runtime snapshot for fast runtime lookup. */
export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const refreshContext =
    getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot) ??
    getActiveSecretsRuntimeRefreshContext() ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      includeAuthStoreRefs: snapshot.authStores.length > 0,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
      loadablePluginOrigins: new Map<string, PluginOrigin>(),
    } satisfies SecretsRuntimeRefreshContext);
  const coercePreflightSnapshot = (
    value: unknown,
    sourceConfig: OpenClawConfig,
  ): PreparedSecretsRuntimeSnapshot | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const candidate = value as PreparedSecretsRuntimeSnapshot;
    return isDeepStrictEqual(candidate.sourceConfig, sourceConfig) ? candidate : null;
  };
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext,
    refreshHandler: {
      preflight: async ({ sourceConfig, includeAuthStoreRefs }) => {
        const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
        const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
        if (!activeSnapshot || !activeRefreshContext) {
          return false;
        }
        return await prepareSecretsRuntimeSnapshot({
          config: sourceConfig,
          env: activeRefreshContext.env,
          agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
          includeAuthStoreRefs: includeAuthStoreRefs ?? activeRefreshContext.includeAuthStoreRefs,
          reuseResolvedConfigRefsFrom: activeSnapshot,
          loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
          ...(activeRefreshContext.manifestRegistry
            ? { manifestRegistry: activeRefreshContext.manifestRegistry }
            : {}),
          ...(activeRefreshContext.loadAuthStore
            ? { loadAuthStore: activeRefreshContext.loadAuthStore }
            : {}),
        });
      },
      refresh: async ({ sourceConfig, includeAuthStoreRefs, preflightResult }) => {
        const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
        const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
        if (!activeSnapshot || !activeRefreshContext) {
          return false;
        }
        const oneShotSkipAuthStoreRefs =
          includeAuthStoreRefs === false && activeRefreshContext.includeAuthStoreRefs;
        const refreshed =
          coercePreflightSnapshot(preflightResult, sourceConfig) ??
          (await prepareSecretsRuntimeSnapshot({
            config: sourceConfig,
            env: activeRefreshContext.env,
            agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
            includeAuthStoreRefs: includeAuthStoreRefs ?? activeRefreshContext.includeAuthStoreRefs,
            reuseResolvedConfigRefsFrom: activeSnapshot,
            loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
            ...(activeRefreshContext.manifestRegistry
              ? { manifestRegistry: activeRefreshContext.manifestRegistry }
              : {}),
            ...(activeRefreshContext.loadAuthStore
              ? { loadAuthStore: activeRefreshContext.loadAuthStore }
              : {}),
          }));
        if (oneShotSkipAuthStoreRefs) {
          refreshed.authStores = getLiveSecretsRuntimeAuthStores();
          setPreparedSecretsRuntimeSnapshotRefreshContext(refreshed, activeRefreshContext);
        }
        activateSecretsRuntimeSnapshot(refreshed);
        return true;
      },
    },
  });
}

export async function refreshActiveSecretsRuntimeSnapshot(): Promise<boolean> {
  const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
  const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
  if (!activeSnapshot || !activeRefreshContext) {
    return false;
  }
  const refreshed = await prepareSecretsRuntimeSnapshot({
    config: activeSnapshot.sourceConfig,
    env: activeRefreshContext.env,
    agentDirs: resolveRefreshAgentDirs(activeSnapshot.sourceConfig, activeRefreshContext),
    includeAuthStoreRefs: activeRefreshContext.includeAuthStoreRefs,
    loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
    ...(activeRefreshContext.manifestRegistry
      ? { manifestRegistry: activeRefreshContext.manifestRegistry }
      : {}),
    ...(activeRefreshContext.loadAuthStore
      ? { loadAuthStore: activeRefreshContext.loadAuthStore }
      : {}),
  });
  activateSecretsRuntimeSnapshot(refreshed);
  return true;
}

export async function prepareSecretsRuntimeSnapshotForConfigWrite(params: {
  config: OpenClawConfig;
  includeAuthStoreRefs?: boolean;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
  const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
  return await prepareSecretsRuntimeSnapshot({
    config: params.config,
    includeAuthStoreRefs: params.includeAuthStoreRefs,
    reuseResolvedConfigRefsFrom: activeSnapshot ?? undefined,
    ...(activeRefreshContext
      ? {
          loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
          ...(activeRefreshContext.manifestRegistry
            ? { manifestRegistry: activeRefreshContext.manifestRegistry }
            : {}),
        }
      : {}),
  });
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  return getActiveSecretsRuntimeSnapshotState();
}

export function getActiveSecretsRuntimeEnv(): NodeJS.ProcessEnv {
  return getActiveSecretsRuntimeEnvState();
}

export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  return getActiveRuntimeWebToolsMetadataFromState();
}

export function clearSecretsRuntimeSnapshot(): void {
  clearSecretsRuntimeSnapshotState();
}
