import net from "node:net";
import tls from "node:tls";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import type { SessionAcpMeta } from "../../acp/control-plane/manager.types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  hookMocks,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "../../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import { resetInboundDedupe } from "../../auto-reply/reply/inbound-dedupe.js";
import type { AcpRuntime } from "../../plugin-sdk/acp-runtime.js";
import { buildPluginApi } from "../api-builder.js";
import { instrumentPluginInstanceApi } from "../api-facades.js";
import { createHookRunner } from "../hooks.js";
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";
import { getPluginInstanceRuntimeSlot } from "../plugin-instance-scope.js";
import { PluginInstance } from "../plugin-instance.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { PluginRuntime } from "./types.js";

let AcpSessionManager: typeof import("../../acp/control-plane/manager.js").AcpSessionManager;
let dispatchReplyFromConfig: typeof import("../../auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let createRuntimeChannel: typeof import("./runtime-channel.js").createRuntimeChannel;

function denyNetwork() {
  const denied = () => {
    throw new Error("OFFLINE_NETWORK_DENIED");
  };
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(denied);
  vi.spyOn(tls, "connect").mockImplementation(denied);
  vi.spyOn(globalThis, "fetch").mockImplementation(denied);
}

beforeAll(async () => {
  denyNetwork();
  ({ AcpSessionManager } = await import("../../acp/control-plane/manager.js"));
  ({ dispatchReplyFromConfig } = await import("../../auto-reply/reply/dispatch-from-config.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
  ({ createRuntimeChannel } = await import("./runtime-channel.js"));
});

function ownedInstance(id: string) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id });
  registry.plugins.push(record);
  return new PluginInstance(id, { record, registry });
}

const current = () => pluginInstanceInvocation.getStore()?.instance;

async function fixture(
  options: {
    retire?: boolean;
    observeOnly?: boolean;
    fail?: boolean;
    surface?: "dispatch" | "dispatchReply" | "run";
    streaming?: boolean;
    adapterStyle?: "prototype" | "own";
  } = {},
) {
  const channelOwner = ownedInstance("discord");
  const acpOwner = ownedInstance(options.streaming ? "offline-agent" : "offline-acp");
  const started = createDeferred();
  const secondStarted = createDeferred();
  const proceed = createDeferred();
  const finalization = createDeferred();
  const delivered = createDeferred();
  const abort = new AbortController();
  let backendSignal: AbortSignal | undefined;
  const sends: string[] = [];
  const previews: string[] = [];
  const previewOwners: string[] = [];
  const observers: string[] = [];
  const backendRuns: string[] = [];
  const deliveryOwners: string[] = [];
  const channel = createRuntimeChannel({ dispatchReplyFromConfig });
  const registry = createEmptyPluginRegistry();
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      id: "offline-acp",
      name: "offline-acp",
      source: "offline",
      registrationMode: "discovery",
      config: {},
      runtime: { channel } as PluginRuntime,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      resolvePath: (value) => value,
      handlers: {
        on(hookName, handler, registrationOptions) {
          registry.typedHooks.push({
            pluginId: "offline-acp",
            source: "offline",
            hookName,
            handler,
            ...registrationOptions,
          });
        },
      },
    }),
    acpOwner,
  );
  api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  const runner = createHookRunner(registry, { catchErrors: false });
  hookMocks.runner.hasHooks.mockImplementation(
    (name) => !options.streaming && name === "reply_dispatch",
  );
  hookMocks.runner.runReplyDispatch.mockImplementation((event, context) => {
    const hookContext = context as Parameters<typeof tryDispatchAcpReplyHook>[1];
    expect(hookContext.dispatchKind).toBe("acp");
    return runner.runReplyDispatch(event, hookContext);
  });
  let meta: SessionAcpMeta = {
    backend: "fixture",
    agent: "main",
    mode: "persistent",
    runtimeSessionName: "fixture",
    state: "idle",
    lastActivityAt: Date.now(),
  };
  const runtime: AcpRuntime = {
    ensureSession: async ({ sessionKey, agentId }) => ({
      sessionKey,
      agentId,
      backend: "fixture",
      runtimeSessionName: "fixture",
    }),
    cancel: async () => {},
    close: async () => {},
    async *runTurn({ handle, signal }) {
      expect(current()).toBe(acpOwner);
      backendSignal = signal;
      backendRuns.push(handle.sessionKey);
      if (handle.sessionKey.endsWith("second")) {
        secondStarted.resolve();
      } else {
        started.resolve();
      }
      if (options.retire) {
        await proceed.promise;
      }
      signal?.throwIfAborted();
      yield { type: "text_delta", text: "offline final", stream: "output" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  const backend = { id: "fixture", runtime: acpOwner.wrap(runtime) };
  const sessionKey = options.streaming
    ? "agent:main:discord:channel:custody"
    : "agent:main:acp:custody";
  const session = (params: { sessionKey: string } = { sessionKey }) => ({
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    cfg: {},
    storePath: "/tmp/mock-sessions.json",
    entry: {
      sessionId: "fixture",
      updatedAt: Date.now(),
      ...(options.streaming ? {} : { acp: meta }),
    },
    ...(options.streaming ? {} : { acp: meta }),
  });
  acpMocks.readAcpSessionEntry.mockImplementation(session);
  sessionStoreMocks.currentEntry = session().entry;
  const manager = new AcpSessionManager({
    listAcpSessions: async () => [],
    loadSessionEntry: session,
    loadSessionEntryAsync: async (params) => session(params),
    prepareSessionControlRead: async () => {
      throw new Error("OFFLINE_UNEXPECTED_SESSION_CONTROL");
    },
    upsertSessionMetaForControl: async () => {
      throw new Error("OFFLINE_UNEXPECTED_SESSION_CONTROL");
    },
    upsertSessionMeta: async ({ mutate, assertCommitAllowed }) => {
      assertCommitAllowed?.();
      meta = mutate(meta, session().entry) ?? meta;
      return session().entry;
    },
    getRuntimeBackend: () => backend,
    requireRuntimeBackend: () => backend,
  });
  acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(manager);
  channelOwner.run(() => {
    getPluginInstanceRuntimeSlot("delivery-fixture")!.runtime = sends;
  });
  const oldQueued = channelOwner.wrap(() => sends.push("stale"));
  const replyResolver: NonNullable<
    Parameters<typeof channel.inbound.dispatch>[0]["replyResolver"]
  > = options.streaming
    ? acpOwner.wrap(async (ctx, replyOptions) => {
        expect(current()).toBe(acpOwner);
        backendSignal = replyOptions?.abortSignal;
        backendRuns.push(ctx.SessionKey!);
        started.resolve();
        if (options.retire) {
          await proceed.promise;
        }
        backendSignal?.throwIfAborted();
        await replyOptions?.onPartialReply?.({ text: "offline preview" });
        return { text: "offline final" };
      })
    : async () => {
        throw new Error("OFFLINE_UNEXPECTED_AGENT_DISPATCH");
      };
  const start = (owner: PluginInstance, key: string, sink: string[]) =>
    owner.run(() => {
      const turn = {
        cfg: {
          diagnostics: { enabled: false },
          acp: {
            enabled: !options.streaming,
            dispatch: { enabled: !options.streaming },
            allowedAgents: ["main"],
          },
        },
        channel: "discord",
        route: { agentId: "main", sessionKey: key },
        ctxPayload: {
          Body: "question",
          BodyForAgent: "question",
          RawBody: "question",
          Provider: "discord",
          Surface: "discord",
          SessionKey: key,
          From: "sender",
          To: "channel:123",
          CommandAuthorized: true,
        },
        admission: { kind: options.observeOnly ? "observeOnly" : "dispatch", reason: "fixture" },
        replyOptions: {
          abortSignal: abort.signal,
          ...(options.streaming
            ? {
                onPartialReply: (payload: { text?: string }) => {
                  previewOwners.push(current()?.pluginId ?? "none");
                  expect(current()).toBe(owner);
                  expect(getPluginInstanceRuntimeSlot("delivery-fixture")?.runtime).toBe(sink);
                  previews.push(payload.text!);
                  return true;
                },
              }
            : {}),
        },
        replyResolver,
        delivery: {
          async deliver(payload) {
            deliveryOwners.push(current()?.pluginId ?? "none");
            expect(current()).toBe(owner);
            expect(getPluginInstanceRuntimeSlot("delivery-fixture")?.runtime).toBe(sink);
            delivered.resolve();
            if (options.fail) {
              throw new Error("synthetic transport failure");
            }
            sink.push(payload.text!);
            return {
              visibleReplySent: true,
              finalization: finalization.promise.then(() => ({ visibleReplySent: true })),
            };
          },
          onDelivered() {
            expect(current()).toBe(owner);
            observers.push("delivered");
          },
          onError() {
            expect(current()).toBe(owner);
            observers.push("error");
          },
        },
      } satisfies Parameters<typeof channel.inbound.dispatch>[0];
      if (options.adapterStyle) {
        const delivery = turn.delivery;
        class Delivery {
          #delegate = delivery;
          deliver(...args: Parameters<typeof delivery.deliver>) {
            return this.#delegate.deliver(...args);
          }
          onDelivered() {
            this.#delegate.onDelivered();
          }
          onError() {
            this.#delegate.onError();
          }
        }
        const instance = new Delivery();
        if (options.adapterStyle === "own") {
          for (const methodName of ["deliver", "onDelivered", "onError"] as const) {
            Object.defineProperty(instance, methodName, {
              value: instance[methodName],
              enumerable: true,
            });
          }
        }
        turn.delivery = Object.freeze(instance);
      }
      if (options.surface === "run") {
        const adapter = {
          ingest: (raw: { id: string; text: string }) => ({ id: raw.id, rawText: raw.text, raw }),
          resolveTurn: () => turn,
        };
        class Ingress {
          #turn = turn;
          ingest(raw: { id: string; text: string }) {
            expect(this.#turn).toBe(turn);
            return adapter.ingest(raw);
          }
          resolveTurn() {
            return this.#turn;
          }
          onFinalize() {
            expect(this.#turn).toBe(turn);
            observers.push("finalized");
          }
        }
        return channel.inbound.run({
          channel: "discord",
          raw: { id: key, text: "question" },
          adapter: options.adapterStyle ? new Ingress() : adapter,
        });
      }
      if (options.surface === "dispatchReply") {
        return channel.inbound.dispatchReply({
          ...turn,
          agentId: "main",
          routeSessionKey: key,
          storePath: "/tmp/mock-sessions.json",
          recordInboundSession: async () => {},
          dispatchReplyFromConfig,
          dispatchReplyWithBufferedBlockDispatcher:
            channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        });
      }
      return channel.inbound.dispatch(turn);
    });
  const work = start(channelOwner, sessionKey, sends);
  return {
    start,
    disposeManager: () => disposeAcpSessionManagerInstance(manager, "fixture-complete"),
    channelOwner,
    acpOwner,
    started,
    abort,
    backendSignal: () => backendSignal,
    secondStarted,
    proceed,
    finalization,
    delivered,
    sends,
    previews,
    previewOwners,
    observers,
    backendRuns,
    deliveryOwners,
    oldQueued,
    work,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  denyNetwork();
  setDiscordTestRegistry();
  resetInboundDedupe();
  resetPluginTtsAndThreadMocks();
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.loadSessionStore.mockReturnValue({});
  sessionStoreMocks.resolveSessionStorePathCore.mockReturnValue("/tmp/mock-sessions.json");
  sessionStoreMocks.resolveSessionStoreEntry.mockReturnValue({ existing: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("registered channel delivery custody", () => {
  it.each([
    { adapterStyle: "prototype", surface: "dispatch" },
    { adapterStyle: "own", surface: "dispatch" },
    { adapterStyle: "prototype", surface: "run" },
    { adapterStyle: "own", surface: "run" },
  ] as const)("preserves frozen class adapters ($surface, $adapterStyle)", async (options) => {
    const f = await fixture({ ...options, streaming: true });
    try {
      f.finalization.resolve();
      await f.work;
      expect(f.previews).toEqual(["offline preview"]);
      expect(f.sends).toEqual(["offline final"]);
      expect(f.observers).toEqual(
        options.surface === "run" ? ["delivered", "finalized"] : ["delivered"],
      );
      expect(f.channelOwner.hasRetainedConsumers).toBe(false);
    } finally {
      f.finalization.resolve();
      await Promise.allSettled([f.work]);
      await f.channelOwner.dispose();
      await f.acpOwner.dispose();
      await f.disposeManager();
    }
  });

  it.each(["dispatch", "dispatchReply", "run"] as const)(
    "drains admitted ACP delivery through retirement and finalization (%s)",
    async (surface) => {
      const f = await fixture({ retire: true, surface });
      let replacement: PluginInstance | undefined;
      try {
        expect(
          await Promise.race([
            f.started.promise.then(() => "started"),
            f.work.then((result) => result),
          ]),
        ).toBe("started");
        f.channelOwner.quiesce();
        const retired = f.channelOwner.dispose();
        replacement = ownedInstance("discord");
        expect(() => f.oldQueued()).toThrow("reloaded or disabled");
        f.proceed.resolve();
        const outcome = await Promise.race([
          f.delivered.promise.then(() => "delivered"),
          f.work.then((result) => result),
        ]);
        expect(f.deliveryOwners).toEqual(["discord"]);
        expect(outcome).toBe("delivered");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.finalization.resolve();
        await f.work;
        expect((await retired).errors).toEqual([]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.observers).toEqual(["delivered"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.proceed.resolve();
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await replacement?.dispose();
        await f.disposeManager();
      }
    },
  );

  it.each(["dispatch", "run"] as const)(
    "keeps fresh agent streaming callbacks with the channel owner (%s)",
    async (surface) => {
      const f = await fixture({ streaming: true, surface });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.backendRuns).toEqual(["agent:main:discord:channel:custody"]);
        expect(f.previewOwners).toEqual(["discord"]);
        expect(f.previews).toEqual(["offline preview"]);
        expect(f.sends).toEqual(["offline final"]);
        expect(f.observers).toEqual(["delivered"]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it.each([
    { streaming: false, surface: "dispatch" },
    { streaming: true, surface: "run" },
  ] as const)(
    "releases admitted custody on caller cancellation ($surface, streaming=$streaming)",
    async (options) => {
      const f = await fixture({ ...options, retire: true });
      try {
        expect(
          await Promise.race([
            f.started.promise.then(() => "started"),
            f.work.then(() => "completed"),
          ]),
        ).toBe("started");
        expect(f.channelOwner.hasRetainedConsumers).toBe(true);
        f.channelOwner.quiesce();
        const retired = f.channelOwner.dispose();
        f.abort.abort(new Error("synthetic caller cancellation"));
        f.proceed.resolve();
        await f.work;
        expect(f.backendSignal()?.aborted).toBe(true);
        expect(f.sends).toEqual([]);
        expect(f.deliveryOwners).toEqual([]);
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
        expect((await retired).errors).toEqual([]);
      } finally {
        f.proceed.resolve();
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );

  it("isolates concurrent distinct channel instances through queued delivery", async () => {
    const f = await fixture({ retire: true });
    const second = ownedInstance("discord");
    const secondSends: string[] = [];
    let secondWork: ReturnType<typeof f.start> | undefined;
    try {
      expect(
        await Promise.race([
          f.started.promise.then(() => "started"),
          f.work.then(() => "completed"),
        ]),
      ).toBe("started");
      second.run(() => {
        getPluginInstanceRuntimeSlot("delivery-fixture")!.runtime = secondSends;
      });
      secondWork = f.start(second, "agent:main:acp:second", secondSends);
      expect(
        await Promise.race([
          f.secondStarted.promise.then(() => "started"),
          secondWork.then(() => "completed"),
        ]),
      ).toBe("started");
      f.channelOwner.quiesce();
      second.quiesce();
      const retired = Promise.all([f.channelOwner.dispose(), second.dispose()]);
      f.proceed.resolve();
      f.finalization.resolve();
      await Promise.all([f.work, secondWork]);
      expect((await retired).map((result) => result.errors)).toEqual([[], []]);
      expect(f.sends).toEqual(["offline final"]);
      expect(secondSends).toEqual(["offline final"]);
      expect(f.observers).toEqual(["delivered", "delivered"]);
      expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      expect(second.hasRetainedConsumers).toBe(false);
    } finally {
      f.proceed.resolve();
      f.finalization.resolve();
      await Promise.allSettled([f.work, secondWork]);
      await f.disposeManager();
      await f.channelOwner.dispose();
      await second.dispose();
      await f.acpOwner.dispose();
    }
  });

  it.each(["success", "assembled-success", "observe-only", "callback-error"] as const)(
    "releases custody after %s without unintended sends",
    async (mode) => {
      const f = await fixture({
        observeOnly: mode === "observe-only",
        fail: mode === "callback-error",
        surface: mode === "assembled-success" ? "dispatchReply" : "dispatch",
      });
      try {
        f.finalization.resolve();
        await f.work;
        expect(f.backendRuns).toEqual(["agent:main:acp:custody"]);
        expect(f.deliveryOwners).toEqual(mode === "observe-only" ? [] : ["discord"]);
        expect(f.sends).toEqual(mode.endsWith("success") ? ["offline final"] : []);
        expect(f.observers).toEqual(
          mode === "observe-only" ? [] : [mode.endsWith("success") ? "delivered" : "error"],
        );
        expect(f.channelOwner.hasRetainedConsumers).toBe(false);
      } finally {
        f.finalization.resolve();
        await Promise.allSettled([f.work]);
        await f.channelOwner.dispose();
        await f.acpOwner.dispose();
        await f.disposeManager();
      }
    },
  );
});
