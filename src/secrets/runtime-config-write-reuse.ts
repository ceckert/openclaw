/** Reuses successfully resolved, unchanged exec-backed SecretRefs across config writes. */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { isPluginIntegrationSecretProviderConfig } from "./provider-integrations.js";
import { secretRefKey } from "./ref-contract.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

function providerAllowsResolvedRefReuse(config: OpenClawConfig, ref: SecretRef): boolean {
  const provider = config.secrets?.providers?.[ref.provider];
  return ref.source === "exec" && !isPluginIntegrationSecretProviderConfig(provider);
}

/** Seeds a resolve cache with active-snapshot values for unchanged exec-backed config refs. */
export function collectReusableResolvedConfigRefs(params: {
  active: Pick<PreparedSecretsRuntimeSnapshot, "sourceConfig" | "resolvedRefValues"> | undefined;
  nextSourceConfig: OpenClawConfig;
}): Map<string, Promise<unknown>> {
  const active = params.active;
  if (
    !active?.resolvedRefValues?.size ||
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
      if (
        providerAllowsResolvedRefReuse(params.nextSourceConfig, ref) &&
        active.resolvedRefValues?.has(key)
      ) {
        memo.set(key, Promise.resolve(active.resolvedRefValues.get(key)));
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

/** Harvests fulfilled resolve-cache values for reuse by later config-write preparations. */
export async function collectSuccessfulResolvedRefValues(
  resolvedByRefKey: Map<string, Promise<unknown>> | undefined,
): Promise<ReadonlyMap<string, unknown>> {
  if (!resolvedByRefKey?.size) {
    return new Map();
  }
  const entries = [...resolvedByRefKey.entries()];
  const settled = await Promise.allSettled(entries.map(([, value]) => value));
  const resolved = new Map<string, unknown>();
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      resolved.set(entries[index]![0], result.value);
    }
  });
  return resolved;
}
