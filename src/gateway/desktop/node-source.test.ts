import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import * as observeBridge from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function createFixture(boundary: "activation" | "pairing" | "attachment") {
  let config: OpenClawConfig = {};
  const reached = createDeferred();
  const release = createDeferred();
  const forwarded: string[] = [];
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async () => {
      if (boundary === "pairing") {
        reached.resolve();
        await release.promise;
      }
      return { identity: "identity", generation: "generation" };
    },
  });
  const client = {
    connId: "node-conn",
    usesSharedGatewayAuth: false,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send(frame: string) {
        const event = JSON.parse(frame) as {
          event: string;
          payload: { id: string; command: string };
        };
        if (event.event !== "node.invoke.request") {
          return;
        }
        forwarded.push(event.payload.command);
        if (boundary === "attachment") {
          reached.resolve();
          return;
        }
        queueMicrotask(() =>
          nodeRegistry.handleInvokeResult({
            id: event.payload.id,
            nodeId: "node",
            connId: "node-conn",
            ok: false,
            error: { code: "FIXTURE", message: "unexpected desktop dispatch" },
          }),
        );
      },
      close: vi.fn(),
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        platform: "linux",
        deviceFamily: "Linux",
        version: "test",
        mode: "node",
      },
      device: { id: "node" },
      commands: [NODE_DESKTOP_STREAM_COMMAND],
    },
  } as unknown as GatewayWsClient;
  nodeRegistry.register(client, { pairingIdentity: "identity", pairingGeneration: "generation" });
  const desktopRegistry = createDesktopSessionRegistry();
  if (boundary === "activation") {
    const activate = desktopRegistry.activate;
    vi.spyOn(desktopRegistry, "activate").mockImplementation(async (request) => {
      await activate(request);
      reached.resolve();
      await release.promise;
    });
  }
  const streamBroker = createNodeDesktopStreamBroker();
  const attached = createDeferred<Awaited<ReturnType<typeof streamBroker.mint>["attached"]>>();
  if (boundary === "attachment") {
    vi.spyOn(streamBroker, "mint").mockReturnValue({
      ticket: "synthetic-ticket",
      attachPath: "/synthetic-attach",
      expiresAtMs: Date.now() + 60_000,
      attached: attached.promise,
      cancel: () => attached.reject(new Error("cancelled")),
    });
  }
  const service = createNodeDesktopService({
    getConfig: () => config,
    nodeRegistry,
    desktopRegistry,
    streamBroker,
  });
  cleanups.push(async () => {
    release.resolve();
    await desktopRegistry.stopAll();
    nodeRegistry.unregister(client.connId);
  });
  return {
    service,
    nodeRegistry,
    desktopRegistry,
    reached: reached.promise,
    release: release.resolve,
    attached,
    forwarded,
    revoke() {
      config = { gateway: { nodes: { commands: { deny: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    },
  };
}

describe("node desktop runtime policy", () => {
  it("refuses an advertised desktop without pairing approval", async () => {
    const fixture = createFixture("attachment");
    const node = fixture.nodeRegistry.get("node");
    if (!node) {
      throw new Error("expected fixture node");
    }
    node.pairingGeneration = undefined;
    await expect(fixture.service.observe({ nodeId: "node", control: false })).rejects.toThrow(
      "reconnect and approve the node capability",
    );
    expect(fixture.forwarded).toEqual([]);
  });

  it.each(["release", "stop"] as const)(
    "joins invocation settlement when owner stop overlaps %s",
    async (firstAction) => {
      const fixture = createFixture("attachment");
      const canceled = createDeferred();
      const finishInvocation = createDeferred();
      const completionOrder: string[] = [];
      const invoke = fixture.nodeRegistry.invoke.bind(fixture.nodeRegistry);
      vi.spyOn(fixture.nodeRegistry, "invoke").mockImplementation(async (request) => {
        const result = await invoke(request);
        canceled.resolve();
        await finishInvocation.promise;
        completionOrder.push("invocation");
        return result;
      });
      const controller = new AbortController();
      const requester = {
        connId: "desktop-panel-client",
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      };
      try {
        const observing = fixture.service.observe({
          nodeId: "node",
          control: false,
          credentials: { password: "synthetic-password" },
          requester,
        });
        await fixture.reached;
        fixture.attached.resolve({ stream: new PassThrough(), auth: "vnc-password" });
        const observed = await observing;
        const retiring = (
          firstAction === "release"
            ? observeBridge.releaseDesktopObserverToken(observed.wsPath, requester)
            : fixture.service.stopNode("node")
        ).then((result) => {
          completionOrder.push(firstAction);
          return result;
        });
        await canceled.promise;
        const stopping = fixture.service.stopNode("node").then(() => {
          completionOrder.push("stop");
        });
        await setImmediate();
        finishInvocation.resolve();
        expect(await retiring).toBe(firstAction === "release" ? true : undefined);
        await stopping;
        expect(completionOrder[0]).toBe("invocation");
      } finally {
        finishInvocation.resolve();
        controller.abort();
      }
    },
  );

  it.each([false, true])("expires only unclaimed streams (claimed=%s)", async (claimed) => {
    vi.useFakeTimers();
    const fixture = createFixture("attachment");
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const invoke = vi.spyOn(fixture.nodeRegistry, "invoke");
    const stream = new PassThrough();
    try {
      const observing = fixture.service.observe({
        nodeId: "node",
        control: false,
        credentials: { password: "synthetic-password" },
      });
      await fixture.reached;
      fixture.attached.resolve({ stream, auth: "vnc-password" });
      const observed = await observing;
      const token = mint.mock.calls[0]![0];
      if (claimed) {
        if (token.attachment.kind !== "stream") {
          throw new Error("expected a streamed node desktop");
        }
        expect(fixture.desktopRegistry.claimStream(token.sourceKey, token.attachment)).toBe(stream);
        expect(
          fixture.desktopRegistry.attachObserver(token.sourceKey, {
            ownerEpoch: token.ownerEpoch,
            control: false,
            close: () => {},
          }),
        ).toBeDefined();
      }
      await vi.advanceTimersByTimeAsync(observed.expiresAtMs - Date.now());
      expect(stream.destroyed).toBe(!claimed);
      expect(fixture.desktopRegistry.hasActivity(token.sourceKey, token.ownerEpoch)).toBe(claimed);
      if (!claimed) {
        await expect(invoke.mock.results[0]!.value).resolves.toMatchObject({ ok: false });
      }
    } finally {
      await fixture.service.stopNode("node");
      vi.useRealTimers();
    }
  });

  it.each([
    { boundary: "activation", revoked: "requester" },
    { boundary: "activation", revoked: "policy" },
    { boundary: "pairing", revoked: "policy" },
  ] as const)(
    "does not dispatch after $revoked revocation during $boundary",
    async ({ boundary, revoked }) => {
      const fixture = createFixture(boundary);
      const controller = new AbortController();
      const observed = fixture.service
        .observe({
          nodeId: "node",
          control: false,
          ...(revoked === "requester"
            ? {
                requester: {
                  signal: controller.signal,
                  isCurrent: () => !controller.signal.aborted,
                },
              }
            : {}),
        })
        .then(
          () => true,
          () => false,
        );
      await fixture.reached;
      if (revoked === "requester") {
        controller.abort();
      } else {
        fixture.revoke();
      }
      fixture.release();
      expect(await observed).toBe(false);
      expect(fixture.forwarded).toEqual([]);
    },
  );

  it("settles a canceled observer while its node pairing lookup is still pending", async () => {
    const fixture = createFixture("pairing");
    const controller = new AbortController();
    let settled = false;
    const observed = fixture.service
      .observe({
        nodeId: "node",
        control: false,
        requester: {
          signal: controller.signal,
          isCurrent: () => !controller.signal.aborted,
        },
      })
      .then(
        () => {
          settled = true;
          return true;
        },
        () => {
          settled = true;
          return false;
        },
      );
    await fixture.reached;
    controller.abort();
    await expect.poll(() => settled).toBe(true);
    expect(await observed).toBe(false);
    expect(fixture.forwarded).toEqual([]);
    fixture.release();
    await Promise.resolve();
    expect(fixture.forwarded).toEqual([]);
  });

  it("keeps requester authority on the observer ticket after node attachment", async () => {
    const fixture = createFixture("attachment");
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const controller = new AbortController();
    const client = { invalidated: false };
    const requester = {
      signal: controller.signal,
      isCurrent: () => !client.invalidated,
    };
    const observed = fixture.service.observe({
      nodeId: "node",
      control: false,
      credentials: { password: "synthetic-password" },
      requester,
    });
    await fixture.reached;
    fixture.attached.resolve({ stream: new PassThrough(), auth: "vnc-password" });

    await expect(observed).resolves.toMatchObject({ transport: "rfb", control: false });
    const mintedRequester = mint.mock.calls[0]?.[0].requester;
    expect(mintedRequester).toBe(requester);
    expect(mintedRequester?.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(mintedRequester?.isCurrent()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("destroys a late attachment instead of publishing a revoked desktop", async () => {
    const fixture = createFixture("attachment");
    const stream = new PassThrough();
    const observed = fixture.service
      .observe({ nodeId: "node", control: false, credentials: { password: "synthetic-password" } })
      .then(
        () => true,
        () => false,
      );
    await fixture.reached;
    fixture.revoke();
    fixture.attached.resolve({ stream, auth: "vnc-password" });

    expect(await observed).toBe(false);
    expect(stream.destroyed).toBe(true);
  });
});

describe("node computer observer custody", () => {
  const request = (command = "screen.snapshot", params: Record<string, unknown> = {}) => ({
    nodeId: "node",
    connId: "node-conn",
    pairingGeneration: "generation",
    owner: "agent-run",
    command,
    params: { executionId: "execution-1", ...params },
  });

  it("uses the node desktop observer epoch to abort input and require a new screenshot", async () => {
    const f = createFixture("attachment");
    const initial = await f.service.beginComputerRequest(request());
    initial?.complete();
    initial?.release();
    const pending = await f.service.beginComputerRequest(
      request("computer.act", { action: "left_click" }),
    );
    const observer = f.desktopRegistry.attachObserver("node:node", {
      ownerEpoch: 1,
      control: true,
      close: vi.fn(),
    });
    expect(observer).toBeDefined();
    expect(pending?.signal?.aborted).toBe(true);
    pending?.release();
    await expect(
      f.service.beginComputerRequest(request("computer.act", { action: "left_click" })),
    ).rejects.toThrow("operator has control");
    const held = await f.service.beginComputerRequest(request());
    held?.complete();
    held?.release();
    observer?.release();
    await expect(
      f.service.beginComputerRequest(request("computer.act", { action: "left_click" })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    const fresh = await f.service.beginComputerRequest(request());
    fresh?.complete();
    fresh?.release();
    const click = await f.service.beginComputerRequest(
      request("computer.act", { action: "left_click" }),
    );
    expect(() => click?.assertCurrent()).not.toThrow();
    click?.release();
  });

  it("does not restore authority using a screenshot begun before takeover", async () => {
    const f = createFixture("attachment");
    const stale = await f.service.beginComputerRequest(request());
    const observer = f.desktopRegistry.attachObserver("node:node", {
      ownerEpoch: 1,
      control: true,
      close: vi.fn(),
    });
    observer?.release();
    stale?.complete();
    stale?.release();
    await expect(
      f.service.beginComputerRequest(request("computer.act", { action: "type", text: "unsafe" })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    await expect(
      f.service.beginComputerRequest(
        request("computer.act", { executionId: "other", action: "left_click" }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    const other = await f.service.beginComputerRequest(
      request("screen.snapshot", { executionId: "other" }),
    );
    other?.complete();
    other?.release();
    await expect(
      f.service.beginComputerRequest(request("computer.act", { action: "left_click" })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });

  it("invalidates captured input at native node disconnect and disposes its observer subscription", async () => {
    const f = createFixture("attachment");
    const observed = await f.service.beginComputerRequest(request());
    observed?.complete();
    observed?.release();
    const active = await f.service.beginComputerRequest(
      request("computer.act", { action: "left_click" }),
    );
    await f.service.stopNode("node");
    expect(active?.signal?.aborted).toBe(true);
    expect(() => active?.assertCurrent()).toThrow("COMPUTER_STALE_OBSERVATION");
    active?.release();
    expect(f.desktopRegistry.hasController("node:node", 1)).toBe(false);
  });
});
