import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import type { preparedProviderCatalogSource } from "./prepared-model-runtime.catalog-source.js";
import { filterPreparedProviderCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

/**
 * Seeds a generation from its owner's last inventory. The superseded inventory must stay local
 * to this call: catalog auth bindings retain their access closures, so capturing it there would
 * chain every generation (and its retired plugin cache) behind the current one.
 */
export function seedPreparedModelCatalogInventory(params: {
  previousInventory: PreparedModelCatalogInventory | undefined;
  agentFacts: PreparedModelRuntimeCatalogAccessParams["agentFacts"];
  pluginFingerprint: string;
  nativeSource: string;
  eligibleProviders: readonly string[];
  providerSources: ReadonlyMap<string, ReturnType<typeof preparedProviderCatalogSource>>;
  normalizeProvider: (provider: string) => string;
}): {
  inventory: PreparedModelCatalogInventory | undefined;
  retainedProviders: ReadonlySet<string>;
  authBound: boolean;
} {
  const { previousInventory, agentFacts, nativeSource, normalizeProvider } = params;
  const previousAuth =
    previousInventory && getPreparedModelFullCatalogAuth(previousInventory.catalog);
  const retainedProviders = new Set(
    params.eligibleProviders.filter(
      (provider) =>
        previousInventory?.pluginFingerprint === params.pluginFingerprint &&
        previousInventory.providers.get(provider)?.source ===
          params.providerSources.get(provider) &&
        hasSamePreparedModelCatalogAuth(
          previousAuth,
          agentFacts,
          (id) => normalizeProvider(id) === provider,
        ),
    ),
  );
  if (!previousInventory || !retainedProviders.size) {
    return { inventory: undefined, retainedProviders, authBound: Boolean(previousAuth) };
  }
  const inventory: PreparedModelCatalogInventory = {
    ...previousInventory,
    catalog: filterPreparedProviderCatalog(previousInventory.catalog, (provider) =>
      retainedProviders.has(normalizeProvider(provider)),
    ),
    runtimeModels: new Map(
      [...previousInventory.runtimeModels].filter(([provider]) =>
        retainedProviders.has(normalizeProvider(provider)),
      ),
    ),
    nativeSource,
    providers: new Map(
      [...previousInventory.providers].filter(([provider]) => retainedProviders.has(provider)),
    ),
    discoveryOrigins: previousInventory.discoveryOrigins.filter(({ provider }) =>
      retainedProviders.has(normalizeProvider(provider)),
    ),
  };
  // Native presence markers and empty credentials do not identify an account.
  const identifiedNativeProviders = new Set(
    previousInventory.nativeSource === nativeSource
      ? Object.entries(agentFacts.credentials).flatMap(([provider, credential]) =>
          credential.type === "api_key" && credential.nativeAuth
            ? []
            : [normalizeProvider(provider)],
        )
      : [],
  );
  const retain = (entry: ModelCatalogSnapshot["entries"][number]) =>
    !entry.nativeRuntime || identifiedNativeProviders.has(normalizeProvider(entry.provider));
  inventory.catalog.entries = inventory.catalog.entries.filter(retain);
  inventory.catalog.routeVariants = inventory.catalog.routeVariants.filter(retain);
  if (inventory.catalog.nativeProviderOutcomes) {
    inventory.catalog.nativeProviderOutcomes = Object.fromEntries(
      Object.entries(inventory.catalog.nativeProviderOutcomes).map(([runtime, outcomes]) => [
        runtime,
        outcomes.filter(({ provider }) =>
          identifiedNativeProviders.has(normalizeProvider(provider)),
        ),
      ]),
    );
  }
  return { inventory, retainedProviders, authBound: Boolean(previousAuth) };
}
