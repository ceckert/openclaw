/**
 * Tests control-plane rate limiting for gateway method dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableGatewayStartupUnavailableError } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;
let clientSequence = 0;

describe("gateway control-plane write rate limit", () => {
  beforeEach(() => {
    clientSequence += 1;
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  function buildContext(logWarn = vi.fn()) {
    return {
      logGateway: {
        warn: logWarn,
      },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildConnect(): NonNullable<
    Parameters<typeof handleGatewayRequest>[0]["client"]
  >["connect"] {
    return {
      role: "operator",
      scopes: ["operator.admin"],
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "macos",
        mode: "ui",
      },
      minProtocol: 1,
      maxProtocol: 1,
    };
  }

  function buildClient() {
    return {
      connect: buildConnect(),
      connId: `conn-${clientSequence}`,
      clientIp: `10.0.0.${clientSequence}`,
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  // [octogee-patch] Trusted local control-plane: authenticated with the shared
  // gateway token (usesSharedGatewayAuth set server-side at handshake), as the
  // in-pod provisioner connects. Uses the clientSequence identity so buckets
  // don't collide across tests.
  function buildTrustedControlPlaneClient() {
    return {
      connect: buildConnect(),
      connId: `conn-${clientSequence}`,
      clientIp: `10.0.0.${clientSequence}`,
      usesSharedGatewayAuth: true,
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  async function runRequest(params: {
    method: string;
    context: Parameters<typeof handleGatewayRequest>[0]["context"];
    client: Parameters<typeof handleGatewayRequest>[0]["client"];
    handler: GatewayRequestHandler;
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: crypto.randomUUID(),
        method: params.method,
      },
      respond,
      client: params.client,
      isWebchatConnect: noWebchat,
      context: params.context,
      extraHandlers: {
        [params.method]: params.handler,
      },
    });
    return respond;
  }

  function respondCall(respond: ReturnType<typeof vi.fn>) {
    const call = respond.mock.calls.at(0);
    if (!call) {
      throw new Error("Expected response call");
    }
    return call as [
      boolean,
      unknown,
      { code?: string; details?: unknown; retryAfterMs?: number; retryable?: boolean }?,
    ];
  }

  it("allows 3 control-plane writes and blocks the 4th in the same minute", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const logWarn = vi.fn();
    const context = buildContext(logWarn);
    const client = buildClient();

    await runRequest({ method: "config.patch", context, client, handler });
    await runRequest({ method: "config.patch", context, client, handler });
    await runRequest({ method: "config.patch", context, client, handler });
    const blocked = await runRequest({ method: "config.patch", context, client, handler });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    const blockedCall = respondCall(blocked);
    const error = blockedCall[2];
    expect(blockedCall[0]).toBe(false);
    expect(blockedCall[1]).toBeUndefined();
    expect(error?.code).toBe("UNAVAILABLE");
    expect(error?.retryable).toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  // [octogee-patch] The trusted local control-plane (shared gateway token,
  // usesSharedGatewayAuth) is exempt from the config.patch rate-limit so the
  // provisioner's one-patch-per-customer blue/green roll isn't serialized at
  // ~48s/customer.
  it("exempts config.patch from the rate limit for the trusted control-plane", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const logWarn = vi.fn();
    const context = buildContext(logWarn);
    const client = buildTrustedControlPlaneClient();

    for (let i = 0; i < 8; i += 1) {
      const respond = await runRequest({ method: "config.patch", context, client, handler });
      expect(respond).toHaveBeenCalledWith(true, undefined, undefined);
    }

    expect(handlerCalls).toHaveBeenCalledTimes(8);
    expect(logWarn).not.toHaveBeenCalled();
  });

  // The exemption is config.patch-specific: other control-plane writes from the
  // same trusted caller still hit the 3/60s cap.
  it("still rate-limits other control-plane writes from the trusted control-plane", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildTrustedControlPlaneClient();

    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });
    const blocked = await runRequest({ method: "update.run", context, client, handler });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    expect(respondCall(blocked)[2]?.code).toBe("UNAVAILABLE");
  });

  it("allows the Crestodian inference ladder to probe more than 3 candidates", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, { ok: false, status: "auth", error: "candidate failed" }, undefined);
    };
    const context = buildContext();
    const client = buildClient();

    const responses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(
        await runRequest({
          method: "crestodian.setup.activate",
          context,
          client,
          handler,
        }),
      );
    }

    expect(handlerCalls).toHaveBeenCalledTimes(4);
    for (const response of responses) {
      expect(response).toHaveBeenCalledWith(
        true,
        { ok: false, status: "auth", error: "candidate failed" },
        undefined,
      );
    }
  });

  it("resets the control-plane write budget after 60 seconds", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();

    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });

    const blocked = await runRequest({ method: "update.run", context, client, handler });
    const blockedCall = respondCall(blocked);
    expect(blockedCall[0]).toBe(false);
    expect(blockedCall[1]).toBeUndefined();
    expect(blockedCall[2]?.code).toBe("UNAVAILABLE");

    vi.advanceTimersByTime(60_001);

    const allowed = await runRequest({ method: "update.run", context, client, handler });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handlerCalls).toHaveBeenCalledTimes(4);
  });

  it("does not consume the write budget for requests refused during suspension", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await runRequest({ method: "config.patch", context, client, handler });
      expect(respondCall(refused)[2]).toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "gateway-suspending" },
      });
    }
    expect(suspension?.release()).toBe(true);

    const allowed = await runRequest({ method: "config.patch", context, client, handler });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handlerCalls).toHaveBeenCalledOnce();
  });

  it("keeps suspension preparation rate-limited while admission is closed", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    const blocked = await runRequest({
      method: "gateway.suspend.prepare",
      context,
      client,
      handler,
    });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    expect(respondCall(blocked)[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(suspension?.release()).toBe(true);
  });

  it.each(STARTUP_UNAVAILABLE_GATEWAY_METHODS)(
    "blocks startup-gated method %s before dispatch with a retryable startup error",
    async (method) => {
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls(opts);
        opts.respond(true, undefined, undefined);
      };
      const context = {
        ...buildContext(),
        unavailableGatewayMethods: new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS),
      } as Parameters<typeof handleGatewayRequest>[0]["context"];
      const client = buildClient();

      const blocked = await runRequest({ method, context, client, handler });

      expect(handlerCalls).not.toHaveBeenCalled();
      const blockedCall = respondCall(blocked);
      const error = blockedCall[2];
      expect(blockedCall[0]).toBe(false);
      expect(blockedCall[1]).toBeUndefined();
      expect(error?.code).toBe("UNAVAILABLE");
      expect(error?.retryable).toBe(true);
      expect(error?.retryAfterMs).toBe(500);
      expect(error?.details).toEqual({ reason: "startup-sidecars", method });
      expect(isRetryableGatewayStartupUnavailableError(error)).toBe(true);
    },
  );
});
