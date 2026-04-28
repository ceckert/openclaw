import { afterEach, describe, expect, test } from "vitest";
import {
  configureControlPlaneRateLimit,
  consumeControlPlaneWriteBudget,
  getControlPlaneRateLimitConfig,
  pruneStaleControlPlaneBuckets,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT,
  __testing,
} from "./control-plane-rate-limit.js";

describe("control-plane-rate-limit", () => {
  afterEach(() => {
    __testing.resetControlPlaneRateLimitState();
  });

  test("pruneStaleControlPlaneBuckets removes expired buckets (#63643)", () => {
    // Create buckets at different times
    const baseMs = 1_000_000;
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-old" } }, clientIp: "1.2.3.4" } as never,
      nowMs: baseMs,
    });
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      nowMs: baseMs + 4 * 60_000,
    });

    // Prune at baseMs + 6 minutes — "dev-old" is > 5 min stale, "dev-recent" is only 2 min
    const pruned = pruneStaleControlPlaneBuckets(baseMs + 6 * 60_000);
    expect(pruned).toBe(1);

    // "dev-recent" should still have budget
    const result = consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      nowMs: baseMs + 6 * 60_000,
    });
    expect(result.allowed).toBe(true);
  });

  test("pruneStaleControlPlaneBuckets is safe on empty map", () => {
    expect(pruneStaleControlPlaneBuckets()).toBe(0);
  });

  test("control-plane bucket map stays bounded between prune sweeps", () => {
    const baseMs = 2_000_000;
    for (let i = 0; i < 10_001; i++) {
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id: `dev-${i}` } },
          clientIp: "1.2.3.4",
        } as never,
        nowMs: baseMs,
      });
    }

    expect(__testing.getControlPlaneRateLimitBucketCount()).toBe(10_000);
  });

  // ── Octogee fork: configurable rate limit ────────────────────────────────

  test("defaults to 3 per 60s when configureControlPlaneRateLimit is never called", () => {
    expect(getControlPlaneRateLimitConfig()).toEqual({
      maxRequests: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT,
      windowMs: CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT,
    });
  });

  test("configureControlPlaneRateLimit raises the ceiling for the same client/window", () => {
    configureControlPlaneRateLimit({ maxRequests: 10, windowMs: 60_000 });
    expect(getControlPlaneRateLimitConfig()).toEqual({ maxRequests: 10, windowMs: 60_000 });

    const baseMs = 3_000_000;
    const client = {
      connect: { device: { id: "dev-burst" } },
      clientIp: "10.0.0.1",
    } as never;

    // First 10 should all succeed (was: only first 3).
    for (let i = 0; i < 10; i++) {
      const r = consumeControlPlaneWriteBudget({ client, nowMs: baseMs });
      expect(r.allowed).toBe(true);
    }
    // 11th should be rejected.
    const denied = consumeControlPlaneWriteBudget({ client, nowMs: baseMs });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test("configureControlPlaneRateLimit ignores zero / negative / non-finite values (defaults preserved)", () => {
    // Pre-set to a valid override so we can detect that bad values don't clobber.
    configureControlPlaneRateLimit({ maxRequests: 10, windowMs: 60_000 });
    configureControlPlaneRateLimit({ maxRequests: 0, windowMs: -5 });
    expect(getControlPlaneRateLimitConfig()).toEqual({ maxRequests: 10, windowMs: 60_000 });

    configureControlPlaneRateLimit({ maxRequests: Number.NaN, windowMs: Number.POSITIVE_INFINITY });
    expect(getControlPlaneRateLimitConfig()).toEqual({ maxRequests: 10, windowMs: 60_000 });
  });

  test("configureControlPlaneRateLimit floors fractional values", () => {
    configureControlPlaneRateLimit({ maxRequests: 12.7, windowMs: 60_500.9 });
    expect(getControlPlaneRateLimitConfig()).toEqual({ maxRequests: 12, windowMs: 60_500 });
  });

  test("__testing.resetControlPlaneRateLimitState restores defaults (lets tests run in isolation)", () => {
    configureControlPlaneRateLimit({ maxRequests: 99, windowMs: 5_000 });
    expect(getControlPlaneRateLimitConfig()).toEqual({ maxRequests: 99, windowMs: 5_000 });

    __testing.resetControlPlaneRateLimitState();
    expect(getControlPlaneRateLimitConfig()).toEqual({
      maxRequests: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS_DEFAULT,
      windowMs: CONTROL_PLANE_RATE_LIMIT_WINDOW_MS_DEFAULT,
    });
  });
});
