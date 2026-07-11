import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { describe, expect, it, vi } from "vitest";
import type { MattermostActivityGatewayRuntime } from "./activity-gateway-runtime.js";
import { registerMattermostAgentGatewayMethods } from "./gateway-methods.js";

type RegisteredHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function createHarness(runtime: MattermostActivityGatewayRuntime) {
  const handlers = new Map<string, RegisteredHandler>();
  const scopes = new Map<string, string | undefined>();
  const api = {
    registerGatewayMethod: (
      method: string,
      handler: RegisteredHandler,
      options?: { scope?: string },
    ) => {
      handlers.set(method, handler);
      scopes.set(method, options?.scope);
    },
  } as unknown as OpenClawPluginApi;
  registerMattermostAgentGatewayMethods(api, { runtime: () => runtime });

  const call = async (method: string, params: Record<string, unknown>, mode = "backend") => {
    const respond = vi.fn();
    const handler = handlers.get(method);
    if (!handler) {
      throw new Error(`Missing gateway handler ${method}`);
    }
    await handler({
      params,
      client: { connect: { client: { mode } } },
      respond,
    } as never);
    return respond;
  };
  return { call, handlers, scopes };
}

function createRuntime(): MattermostActivityGatewayRuntime {
  return {
    status: vi.fn(async (inputPostId) => ({
      inputPostId,
      conversationId: "channel-1",
      turnId: "post-1",
      state: "pending" as const,
      revision: 2,
    })),
    cancel: vi.fn(async () => ({ outcome: "canceled" as const, revision: 3 })),
    retry: vi.fn(async () => ({
      outcome: "accepted" as const,
      inputPostId: "retry-marker",
      turnId: "post-1",
    })),
    snapshot: vi.fn(async () => ({
      schemaVersion: 1 as const,
      generatedAt: 100,
      runs: [],
      admissions: [],
    })),
  };
}

describe("Mattermost agent gateway methods", () => {
  it("registers the frozen methods with least-privilege scopes", () => {
    const harness = createHarness(createRuntime());

    expect(Object.fromEntries(harness.scopes)).toEqual({
      "mattermost.ingress.status": "operator.read",
      "mattermost.ingress.cancel": "operator.write",
      "mattermost.ingress.retry": "operator.write",
      "agent.activity.snapshot": "operator.read",
    });
  });

  it.each([
    ["mattermost.ingress.status", { inputPostId: "post-1" }],
    ["mattermost.ingress.cancel", { inputPostId: "post-1", idempotencyKey: "remove:post-1" }],
    [
      "mattermost.ingress.retry",
      {
        failedRunId: "run-1",
        markerPostId: "marker-1",
        actorMmUserId: "user-1",
        idempotencyKey: "retry:run-1",
      },
    ],
    ["agent.activity.snapshot", {}],
  ])("rejects non-backend clients before %s reaches runtime state", async (method, params) => {
    const runtime = createRuntime();
    const respond = await createHarness(runtime).call(method, params, "ui");

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "Mattermost activity methods require an authenticated backend client",
    });
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.retry).not.toHaveBeenCalled();
    expect(runtime.snapshot).not.toHaveBeenCalled();
  });

  it("returns authoritative status, cancel, retry, and snapshot outcomes", async () => {
    const runtime = createRuntime();
    const harness = createHarness(runtime);

    const status = await harness.call("mattermost.ingress.status", { inputPostId: "post-1" });
    const cancel = await harness.call("mattermost.ingress.cancel", {
      inputPostId: "post-1",
      idempotencyKey: "remove:post-1",
    });
    const retry = await harness.call("mattermost.ingress.retry", {
      failedRunId: "run-1",
      markerPostId: "marker-1",
      actorMmUserId: "user-1",
      idempotencyKey: "retry:run-1",
    });
    const snapshot = await harness.call("agent.activity.snapshot", {});

    expect(status).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ inputPostId: "post-1", revision: 2 }),
    );
    expect(cancel).toHaveBeenCalledWith(true, { outcome: "canceled", revision: 3 });
    expect(retry).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ outcome: "accepted", inputPostId: "retry-marker" }),
    );
    expect(snapshot).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ schemaVersion: 1, generatedAt: 100 }),
    );
  });

  it("rejects extra or missing parameters without invoking the runtime", async () => {
    const runtime = createRuntime();
    const harness = createHarness(runtime);

    const missing = await harness.call("mattermost.ingress.status", {});
    const extra = await harness.call("agent.activity.snapshot", { browser: true });

    expect(missing).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(extra).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.snapshot).not.toHaveBeenCalled();
  });
});
