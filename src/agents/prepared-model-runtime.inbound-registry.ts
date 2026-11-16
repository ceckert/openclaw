import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  listRuntimePluginIdsFromRegistry,
  createRuntimePluginManifestLookup,
} from "../plugins/active-runtime-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryGatewayOwner } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getReusablePluginRuntimeActivation } from "../plugins/runtime/load-context.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandleAsync } from "./runtime-plugins.js";

type PreparedInboundRegistryInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "env" | "workspaceDir" | "allowGatewaySubagentBinding"
>;

export type PreparedInboundRegistryLoader = (
  input: PreparedInboundRegistryInput,
  metadataSnapshot: PluginMetadataSnapshot,
  configuredHarnessRuntimes?: readonly string[],
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
) => Promise<PluginRegistry>;

function inboundRegistryIdentity(input: PreparedInboundRegistryInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
  });
}

/** Groups model-selected workspace facts while keeping generic inbound identity narrower. */
export function preparedModelRuntimeWorkspaceFactsKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    readOnly: input.readOnly === true,
    loadRuntimePlugins: input.loadRuntimePlugins === true,
    runtimePluginPurpose: input.runtimePluginPurpose,
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    // Normalization already resolves each model to its runtime. The workspace
    // registry depends on provider/runtime ownership, not the model id itself.
    runtimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({
      provider,
      runtime,
    })),
  });
}

/** Gateway-hosted prepared loads borrow unchanged instances from the live Gateway registry. */
function resolveLendingGatewayRegistry(
  input: PreparedInboundRegistryInput,
): PluginRegistry | undefined {
  if (input.allowGatewaySubagentBinding !== true || input.env !== undefined) {
    return undefined;
  }
  // Startup and admitted turns carry their Gateway registry through the same scope.
  // A process-active sibling with matching files is not this caller's runtime owner.
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  // The loader checks each borrowed plugin's source, manifest and activation;
  // global instances can remain identical across workspace registries.
  return requestRegistry && getPluginRegistryGatewayOwner(requestRegistry)?.current();
}

/** Loads generic plugin facts without acquiring model, catalog, or credential state. */
export async function loadPreparedInboundPluginRegistry(
  input: PreparedInboundRegistryInput,
  metadataSnapshot = prepareOwnedPluginLoadContext(input, input.env ?? process.env, undefined),
  configuredHarnessRuntimes?: readonly string[],
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
): Promise<PluginRegistry> {
  const gatewayRegistry = resolveLendingGatewayRegistry(input);
  // Registry-owned facts survive an outer reload cache without allowing stale
  // metadata or changed activation inputs to reuse already-registered callbacks.
  const reusableGatewayRegistry =
    gatewayRegistry &&
    getReusablePluginRuntimeActivation(gatewayRegistry, {
      config: input.config,
      env: process.env,
      workspaceDir: metadataSnapshot.workspaceDir,
      metadataSnapshot,
    }) &&
    listRuntimePluginIdsFromRegistry(gatewayRegistry).every(
      createRuntimePluginManifestLookup(gatewayRegistry, metadataSnapshot.manifestRegistry.plugins),
    )
      ? gatewayRegistry
      : undefined;
  const registry =
    reusableGatewayRegistry ??
    (await loadAgentRuntimePluginRegistryHandleAsync(
      {
        config: input.config,
        env: input.env ?? process.env,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
        metadataSnapshot,
        preferBuiltPluginArtifacts: true,
        configuredHarnessRuntimes,
        borrowRegistry: gatewayRegistry,
      },
      onPrimaryRegistry,
    ));
  if (reusableGatewayRegistry) {
    onPrimaryRegistry?.(reusableGatewayRegistry);
  }
  prepareOwnedPluginLoadContext(input, input.env ?? process.env, registry, metadataSnapshot, true);
  return registry;
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader {
  const registries = new Map<
    string,
    {
      metadataSnapshot: PluginMetadataSnapshot;
      result: Promise<{ registry: PluginRegistry; primaryRegistry: PluginRegistry }>;
    }
  >();
  return async (input, metadataSnapshot, configuredHarnessRuntimes, onPrimaryRegistry) => {
    const key = inboundRegistryIdentity(input);
    let entry = registries.get(key);
    if (entry?.metadataSnapshot !== metadataSnapshot) {
      let primary: PluginRegistry | undefined;
      const result = loadPreparedInboundPluginRegistry(
        input,
        metadataSnapshot,
        configuredHarnessRuntimes,
        (source) => {
          primary = source;
        },
      ).then((registry) => ({ registry, primaryRegistry: primary ?? registry }));
      entry = { metadataSnapshot, result };
      registries.set(key, entry);
    }
    const { registry, primaryRegistry } = await entry.result.catch((error: unknown) => {
      if (registries.get(key) === entry) {
        registries.delete(key);
      }
      throw error;
    });
    onPrimaryRegistry?.(primaryRegistry);
    return registry;
  };
}

type PreparedWorkspacePluginRegistries = {
  runtimePluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
  primaryRegistry?: PluginRegistry;
};

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export async function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
  retainRegistry: (registry: PluginRegistry) => void,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
  preferBuiltPluginArtifacts = false,
  reusableGeneration?: PreparedModelRuntimePluginGeneration,
  getConfiguredHarnessRuntimes?: () => readonly string[],
  basePluginIds?: readonly string[],
  loadRuntimeRegistry:
    | PreparedModelRuntimeBuildResources["load"]
    | typeof loadAgentRuntimePluginRegistryHandleAsync = loadAgentRuntimePluginRegistryHandleAsync,
): Promise<PreparedWorkspacePluginRegistries> {
  // Passive reads stay runtime-free; executable probes carry explicit scope.
  if (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) {
    return {};
  }
  // Resolve batch facts only for a registry load; read-only and reused registries need no scan.
  let primaryRegistry: PluginRegistry | undefined;
  const inboundPluginRegistry =
    input.readOnly || input.runtimePluginPurpose === "isolated-completion"
      ? undefined
      : (reusableGeneration?.inboundPluginRegistry ??
        (await loadInboundRegistry?.(
          input,
          metadataSnapshot,
          getConfiguredHarnessRuntimes?.(),
          (source) => {
            primaryRegistry = source;
          },
        )));
  const baseRegistry = reusableGeneration?.pluginRegistry ?? inboundPluginRegistry;
  for (const registry of new Set([inboundPluginRegistry, baseRegistry])) {
    if (registry) {
      retainRegistry(registry);
    }
  }
  primaryRegistry ??= reusableGeneration?.mediaCapabilityProviderSource?.registry ?? baseRegistry;
  let loadedPrimaryRegistry: PluginRegistry | undefined;
  const runtimePluginRegistry =
    input.runtimePluginSelections || !baseRegistry
      ? await loadRuntimeRegistry(
          {
            ...(input.loadRuntimePlugins
              ? { basePluginIds: [] }
              : baseRegistry
                ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) }
                : basePluginIds !== undefined
                  ? { basePluginIds }
                  : {}),
            // Inbound preparation already admitted this exact context. Let the runtime
            // planner check selected owners before acquiring another captured registry.
            ...(baseRegistry ? { reusableRegistry: baseRegistry } : {}),
            purpose: input.runtimePluginPurpose,
            config: input.config,
            env: input.env ?? process.env,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
            ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
            metadataSnapshot,
            ...(preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
            selections: input.runtimePluginSelections,
            configuredHarnessRuntimes: getConfiguredHarnessRuntimes?.(),
            borrowRegistry: resolveLendingGatewayRegistry(input),
          },
          (source) => {
            loadedPrimaryRegistry =
              reusableGeneration && source === reusableGeneration.pluginRegistry
                ? (reusableGeneration.mediaCapabilityProviderSource?.registry ?? source)
                : source;
          },
        )
      : baseRegistry;
  retainRegistry(runtimePluginRegistry);
  return {
    runtimePluginRegistry,
    primaryRegistry:
      runtimePluginRegistry === baseRegistry
        ? (primaryRegistry ?? runtimePluginRegistry)
        : (loadedPrimaryRegistry ?? runtimePluginRegistry),
    ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
  };
}
