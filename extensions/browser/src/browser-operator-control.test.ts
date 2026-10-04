import "./browser-tool.test-support.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserOperatorOperation,
  resolveBrowserOperatorControl,
} from "./browser-operator-control.js";
import { getBrowserStateRuntime, setBrowserStateRuntime } from "./browser-runtime-state.js";
import { createBrowserTool } from "./browser-tool.js";
import { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
import { handleBrowserGatewayRequest } from "./gateway/browser-request.js";

const { browserActionsMocks, browserConfigMocks, resetBrowserToolMocks } =
  await import("./browser-tool.test-support.js");

beforeEach(() => {
  resetBrowserToolMocks();
  setBrowserStateRuntime({
    dashboardOperations: new Map(),
    sessionTabs: {} as never,
    sessionTabOperations: new Map(),
  });
  browserConfigMocks.resolveBrowserConfig.mockReturnValue({
    enabled: true,
    controlPort: 18791,
    profiles: { openclaw: { cdpPort: 18792 } },
    defaultProfile: "openclaw",
    actionTimeoutMs: 60_000,
  });
});
afterEach(() => {
  for (const control of getBrowserStateRuntime().operatorControls?.values() ?? []) {
    control.dispose();
  }
});
function profile() {
  return resolveProfile(resolveBrowserConfig({}), "openclaw")!;
}
function requester(connId = "operator") {
  return { connId, signal: new AbortController().signal, isCurrent: () => true };
}
async function rpc(control: boolean, clientOverrides = {}) {
  const respond = vi.fn();
  await handleBrowserGatewayRequest({
    params: {
      target: "host",
      method: "POST",
      path: "/control",
      body: { profile: "openclaw", control },
    },
    client: {
      connId: "operator",
      connectionSignal: new AbortController().signal,
      ...clientOverrides,
    },
    respond,
    context: {},
  } as never);
  return respond;
}

describe("native Browser operator control", () => {
  it("requires each independent tool owner to refresh after takeover", async () => {
    const tools = [createBrowserTool(), createBrowserTool()];
    const snapshot = (tool: (typeof tools)[number]) =>
      tool.execute("snapshot", { action: "snapshot", target: "host", targetId: "tab-1" });
    const navigate = (tool: (typeof tools)[number]) =>
      tool.execute("go", {
        action: "navigate",
        target: "host",
        targetUrl: "https://example.test",
        targetId: "tab-1",
      });
    await Promise.all(tools.map(snapshot));
    await rpc(true);
    await rpc(false);
    await snapshot(tools[0]!);
    await navigate(tools[0]!);
    await expect(navigate(tools[1]!)).rejects.toThrow("BROWSER_STALE_OBSERVATION");
    await snapshot(tools[1]!);
    await navigate(tools[1]!);
  });

  it("gates the real host Browser tool and requires a fresh snapshot after release", async () => {
    const acquired = await rpc(true);
    expect(acquired).toHaveBeenCalledWith(true, {
      controlled: true,
      owned: true,
      needsObservation: true,
    });
    const tool = createBrowserTool();
    const navigate = () =>
      tool.execute("go", {
        action: "navigate",
        target: "host",
        targetUrl: "https://example.test",
        targetId: "tab-1",
      });
    await expect(navigate()).rejects.toThrow("operator has control");
    await tool.execute("held", { action: "snapshot", target: "host", targetId: "tab-1" });
    await rpc(false);
    await expect(navigate()).rejects.toThrow("BROWSER_STALE_OBSERVATION");
    await tool.execute("fresh", { action: "snapshot", target: "host", targetId: "tab-1" });
    await navigate();
    expect(browserActionsMocks.browserNavigate).toHaveBeenCalledTimes(1);
  });

  it("aborts active input and ignores observations made before takeover", () => {
    const state = resolveBrowserOperatorControl(profile())!;
    const input = beginBrowserOperatorOperation("navigate", profile())!;
    const stale = beginBrowserOperatorOperation("snapshot", profile())!;
    const user = requester();
    state.set(true, user);
    expect(input.signal.aborted).toBe(true);
    input.release();
    state.set(false, user);
    stale.complete(true);
    stale.release();
    expect(() => beginBrowserOperatorOperation("navigate", profile())).toThrow(
      "BROWSER_STALE_OBSERVATION",
    );
  });

  it("binds control to native connection lifetime and rejects agent attempts to release it", async () => {
    const signal = new AbortController();
    await rpc(true, { connectionSignal: signal.signal });
    const denied = await rpc(false, { internal: { syntheticClient: true } });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("authenticated operator") }),
    );
    expect(resolveBrowserOperatorControl(profile())!.status().controlled).toBe(true);
    signal.abort();
    expect(resolveBrowserOperatorControl(profile())!.status()).toEqual({
      controlled: false,
      owned: false,
      needsObservation: true,
    });
  });

  it("cancels the real host Browser tool when operator takeover arrives during input", async () => {
    const pending = createDeferred<Record<string, unknown>>();
    const started = createDeferred<void>();
    let operationSignal: AbortSignal | undefined;
    browserActionsMocks.browserNavigate.mockImplementationOnce(async (...args: unknown[]) => {
      operationSignal = (args[1] as { signal?: AbortSignal }).signal;
      started.resolve();
      return (await pending.promise) as never;
    });
    const tool = createBrowserTool();
    const operation = tool.execute("go", {
      action: "navigate",
      target: "host",
      targetUrl: "https://example.test",
      targetId: "tab-1",
    });
    await started.promise;
    await rpc(true);
    expect(operationSignal?.aborted).toBe(true);
    pending.resolve({ ok: true });
    await operation;
  });
});
