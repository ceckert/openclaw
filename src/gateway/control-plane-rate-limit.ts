import type { GatewayClient } from "./server-methods/types.js";

/**
 * Default rate limit. The runtime can override these at server startup
 * via {@link configureControlPlaneRateLimit}, which the bootstrap reads
 * from `gateway.controlPlane.writeRateLimit.{maxRequests, windowMs}` in
 * openclaw.json (mirrors the existing `gateway.auth.rateLimit` pattern).
 *
 * **Octogee fork**: 3-per-60s is too tight for any platform that mounts
 * customers via a single `gateway-client` device. Three customer signups
 * a minute and we're throttled. Making this configurable lets ops tune
 * the ceiling without re-cutting the image.
 */
export const CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT = 3;
export const CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT = 60_000;
const CONTROL_PLANE_BUCKET_MAX_STALE_MS = 5 * 60_000;
/** Hard cap to prevent memory DoS from rapid unique-key injection (CWE-400). */
const CONTROL_PLANE_BUCKET_MAX_ENTRIES = 10_000;

let configuredMaxRequests: number = CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT;
let configuredWindowMs: number = CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT;

/**
 * Override the rate-limit ceiling at server startup. Both fields optional;
 * unspecified values fall back to defaults. Negative or non-finite values
 * are ignored (treated as "use default") so a malformed config can't open
 * a hole or set an unreachable limit.
 */
export function configureControlPlaneRateLimit(opts: {
  maxRequests?: number;
  windowMs?: number;
}): void {
  if (
    typeof opts.maxRequests === "number" &&
    Number.isFinite(opts.maxRequests) &&
    opts.maxRequests > 0
  ) {
    configuredMaxRequests = Math.floor(opts.maxRequests);
  }
  if (typeof opts.windowMs === "number" && Number.isFinite(opts.windowMs) && opts.windowMs > 0) {
    configuredWindowMs = Math.floor(opts.windowMs);
  }
}

/** Snapshot the currently-effective limits — used by error messages + tests. */
export function getControlPlaneRateLimitConfig(): {
  maxRequests: number;
  windowMs: number;
} {
  return { maxRequests: configuredMaxRequests, windowMs: configuredWindowMs };
}

type Bucket = {
  count: number;
  windowStartMs: number;
};

const controlPlaneBuckets = new Map<string, Bucket>();

function normalizePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveControlPlaneRateLimitKey(client: GatewayClient | null): string {
  const deviceId = normalizePart(client?.connect?.device?.id, "unknown-device");
  const clientIp = normalizePart(client?.clientIp, "unknown-ip");
  if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
    // Last-resort fallback: avoid cross-client contention when upstream identity is missing.
    const connId = normalizePart(client?.connId, "");
    if (connId) {
      return `${deviceId}|${clientIp}|conn=${connId}`;
    }
  }
  return `${deviceId}|${clientIp}`;
}

export function consumeControlPlaneWriteBudget(params: {
  client: GatewayClient | null;
  nowMs?: number;
}): {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
  key: string;
} {
  const nowMs = params.nowMs ?? Date.now();
  const key = resolveControlPlaneRateLimitKey(params.client);
  const bucket = controlPlaneBuckets.get(key);
  // Snapshot the configured limits ONCE per call so error messages and
  // remaining-count math stay consistent even if the config is mutated
  // mid-call (it isn't, but the snapshot is cheap and explicit).
  const maxRequests = configuredMaxRequests;
  const windowMs = configuredWindowMs;

  if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
    // Enforce hard cap before inserting a new key to bound memory usage
    // even between periodic prune sweeps.
    if (
      !controlPlaneBuckets.has(key) &&
      controlPlaneBuckets.size >= CONTROL_PLANE_BUCKET_MAX_ENTRIES
    ) {
      const oldest = controlPlaneBuckets.keys().next().value;
      if (oldest !== undefined) {
        controlPlaneBuckets.delete(oldest);
      }
    }
    controlPlaneBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: maxRequests - 1,
      key,
    };
  }

  if (bucket.count >= maxRequests) {
    const retryAfterMs = Math.max(0, bucket.windowStartMs + windowMs - nowMs);
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      key,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, maxRequests - bucket.count),
    key,
  };
}

/**
 * Remove buckets whose rate-limit window expired more than
 * CONTROL_PLANE_BUCKET_MAX_STALE_MS ago.  Called periodically
 * by the gateway maintenance timer to prevent unbounded growth.
 */
export function pruneStaleControlPlaneBuckets(nowMs = Date.now()): number {
  let pruned = 0;
  for (const [key, bucket] of controlPlaneBuckets) {
    if (nowMs - bucket.windowStartMs > CONTROL_PLANE_BUCKET_MAX_STALE_MS) {
      controlPlaneBuckets.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

export const __testing = {
  getControlPlaneRateLimitBucketCount() {
    return controlPlaneBuckets.size;
  },
  resetControlPlaneRateLimitState() {
    controlPlaneBuckets.clear();
    configuredMaxRequests = CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT;
    configuredWindowMs = CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT;
  },
};
