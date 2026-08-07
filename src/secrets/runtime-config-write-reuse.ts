/** Reuses successfully resolved, unchanged exec-backed SecretRefs across config writes. */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPluginIntegrationSecretProviderConfig } from "./provider-integrations.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

/**
 * Seeds a resolve cache with the active snapshot's successfully resolved
 * exec-backed values — config refs and auth-store refs alike; the latter are
 * the per-agent broker-token refs whose cold re-resolution on every automatic
 * refresh is what melts provisioning bursts. Reuse requires the whole
 * `secrets` section to be unchanged; changed refs resolve cold because their
 * keys miss, and explicit `secrets.reload` never seeds at all.
 */
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
  for (const [key, value] of active.resolvedRefValues) {
    const [source, provider] = key.split(":", 2);
    if (source !== "exec" || !provider) {
      continue;
    }
    const providerConfig = params.nextSourceConfig.secrets?.providers?.[provider];
    if (!providerConfig || isPluginIntegrationSecretProviderConfig(providerConfig)) {
      continue;
    }
    memo.set(key, Promise.resolve(value));
  }
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
