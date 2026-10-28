import type { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
import { createMattermostMonitorResources } from "./monitor-resources.js";
import { createMattermostSystemEventHandler } from "./monitor-system-events.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";

const LOOPBACK_TOKEN = "mattermost-loopback-system-event-token";
const CHANNEL_ID = "chan-1";
const BOT_USER_ID = "bot-user";
const SESSION_KEY = `mattermost:default:channel:${CHANNEL_ID}`;

const state = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  reportChannelRoomJoin: vi.fn<typeof reportChannelRoomJoin>(async () => ({ kind: "posted" })),
  runtimeCore: undefined as unknown,
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  getMattermostRuntime: () => state.runtimeCore,
  getOptionalMattermostRuntime: () => state.runtimeCore,
}));
vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: state.reportChannelRoomJoin,
}));

afterEach(() => {
  state.enqueueSystemEvent.mockClear();
  state.reportChannelRoomJoin.mockClear();
});

async function withLoopbackMattermost(run: (baseUrl: string, requests: string[]) => Promise<void>) {
  const requests: string[] = [];
  const payloads: Record<string, unknown> = {
    [`/api/v4/channels/${CHANNEL_ID}`]: {
      id: CHANNEL_ID,
      name: "deploys",
      display_name: "Deploys",
      type: "O",
      purpose: "Ship things",
      header: "Deploy window: weekdays",
    },
    "/api/v4/users/user-1": { id: "user-1", username: "alice", update_at: 1 },
    "/api/v4/users/user-2": { id: "user-2", username: "bob", update_at: 1 },
    [`/api/v4/channels/${CHANNEL_ID}/posts?per_page=100&skipFetchThreads=true`]: {
      order: ["post-new", "post-old", "post-system"],
      posts: {
        "post-new": { id: "post-new", user_id: "user-2", message: "second" },
        "post-old": { id: "post-old", user_id: "user-1", message: "first" },
        "post-system": { id: "post-system", user_id: "user-1", message: "x", type: "system_join" },
      },
    },
  };
  await withServer(
    (request, response) => {
      const url = request.url ?? "";
      requests.push(`${request.method ?? "GET"} ${url}`);
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      const payload = Object.hasOwn(payloads, url) ? payloads[url] : undefined;
      response.writeHead(payload ? 200 : 404);
      response.end(JSON.stringify(payload ?? { message: "unknown loopback endpoint" }));
    },
    (baseUrl) => run(baseUrl, requests),
  );
}

function createHandler(
  baseUrl: string,
  options: {
    groupPolicy?: "open" | "disabled";
    /** Configuration the gateway holds at event time when it differs from startup. */
    current?: { groupPolicy?: "open" | "disabled"; enabled?: boolean };
  } = {},
) {
  const groupPolicy = options.groupPolicy ?? "open";
  const runtimeCore = createPluginRuntimeMock();
  runtimeCore.channel.routing.resolveAgentRoute = () => ({
    channel: "mattermost",
    matchedBy: "default",
    accountId: "default",
    agentId: "main",
    lastRoutePolicy: "main",
    mainSessionKey: SESSION_KEY,
    sessionKey: SESSION_KEY,
  });
  runtimeCore.system.enqueueSystemEvent = state.enqueueSystemEvent;
  state.runtimeCore = runtimeCore;
  const connection = { baseUrl, botToken: LOOPBACK_TOKEN };
  const client = createMattermostClient({ ...connection, allowPrivateNetwork: true });
  const resources = createMattermostMonitorResources({
    accountId: "default",
    callbackUrl: "http://127.0.0.1:9/mattermost/callback",
    client,
    logger: { debug: () => {} },
    mediaMaxBytes: 1024,
    saveRemoteMedia: async () => ({ path: "/tmp/mattermost-loopback-media" }),
    mediaKindFromMime: () => null,
  });
  const cfg = {
    channels: { mattermost: { ...connection, enabled: true, dmPolicy: "open", groupPolicy } },
  };
  const currentCfg = options.current
    ? { channels: { mattermost: { ...cfg.channels.mattermost, ...options.current } } }
    : cfg;
  runtimeCore.config.current = vi.fn(() => currentCfg);
  const monitor = {
    account: resolveMattermostAccount({ cfg }),
    botUserId: BOT_USER_ID,
    cfg,
    client,
    core: runtimeCore,
    groupPolicy,
    pairing: { readAllowFromStore: async () => [] },
    resources,
    runtime: { error: vi.fn() },
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as MattermostMonitorContext;
  return createMattermostSystemEventHandler(monitor);
}

const postEvent = (
  event: "post_edited" | "post_deleted",
  post: Record<string, unknown>,
): MattermostEventPayload => ({
  event,
  data: { post: JSON.stringify({ channel_id: CHANNEL_ID, ...post }) },
  broadcast: { channel_id: CHANNEL_ID },
});

describe("mattermost system events", () => {
  it.each([
    { event: "post_edited" as const, verb: "edited" },
    { event: "post_deleted" as const, verb: "deleted" },
  ])("forwards a user's $event as a routed system event", async ({ event, verb }) => {
    await withLoopbackMattermost(async (baseUrl) => {
      const handler = createHandler(baseUrl);
      await handler(postEvent(event, { id: "post-1", user_id: "user-1", update_at: 42 }));
      expect(state.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        `Mattermost message ${verb} by @alice in #deploys (post post-1).`,
        expect.objectContaining({
          sessionKey: SESSION_KEY,
          contextKey: `mattermost:post:${verb}:post-1:42`,
        }),
      );
    });
  });

  it("routes a threaded edit to the thread session", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const handler = createHandler(baseUrl);
      await handler(
        postEvent("post_edited", { id: "post-reply", user_id: "user-1", root_id: "root-1" }),
      );
      expect(state.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: `${SESSION_KEY}:thread:root-1` }),
      );
    });
  });

  it.each([
    { label: "the bot's own edit", post: { id: "preview", user_id: BOT_USER_ID } },
    { label: "a system post", post: { id: "sys", user_id: "user-1", type: "system_header" } },
  ])("ignores $label", async ({ post }) => {
    await withLoopbackMattermost(async (baseUrl) => {
      const handler = createHandler(baseUrl);
      await handler(postEvent("post_edited", post));
      expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
    });
  });

  it.each([
    { event: "user_added" as const, verb: "joined" },
    { event: "user_removed" as const, verb: "left" },
  ])("forwards another member's $event", async ({ event, verb }) => {
    await withLoopbackMattermost(async (baseUrl) => {
      const handler = createHandler(baseUrl);
      await handler({ event, data: { user_id: "user-2" }, broadcast: { channel_id: CHANNEL_ID } });
      expect(state.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        `Mattermost: @bob ${verb} #deploys.`,
        expect.objectContaining({
          sessionKey: SESSION_KEY,
          contextKey: `mattermost:member:${verb}:${CHANNEL_ID}:user-2`,
        }),
      );
      expect(state.reportChannelRoomJoin).not.toHaveBeenCalled();
    });
  });

  it("introduces the bot with channel purpose and recent posts when it is added", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const handler = createHandler(baseUrl);
      await handler({
        event: "user_added",
        data: { user_id: BOT_USER_ID, team_id: "team-1" },
        broadcast: { channel_id: CHANNEL_ID },
      });
      expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.reportChannelRoomJoin).toHaveBeenCalledTimes(1);
      const params = state.reportChannelRoomJoin.mock.lastCall?.[0];
      expect(params).toMatchObject({
        channel: "mattermost",
        conversationId: CHANNEL_ID,
        deliverTo: `channel:${CHANNEL_ID}`,
        roomAllowed: true,
        route: { agentId: "main", sessionKey: SESSION_KEY },
      });
      await expect(params?.resolveRoomContext({ messageLimit: 100 })).resolves.toEqual({
        title: "Deploys",
        purpose: "Ship things\nDeploy window: weekdays",
        recentMessages: [
          { sender: "alice", text: "first" },
          { sender: "bob", text: "second" },
        ],
      });
    });
  });

  it.each([
    { label: "the group policy is disabled", options: { groupPolicy: "disabled" as const } },
    {
      label: "the group policy was disabled after the monitor started",
      options: { current: { groupPolicy: "disabled" as const } },
    },
    {
      label: "the account was disabled after the monitor started",
      options: { current: { enabled: false } },
    },
  ])("skips the introduction without reading or posting when $label", async ({ options }) => {
    const { reportChannelRoomJoin: ownerReportChannelRoomJoin } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")
    >("openclaw/plugin-sdk/channel-join-intro-runtime");
    state.reportChannelRoomJoin.mockImplementationOnce(ownerReportChannelRoomJoin);
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const handler = createHandler(baseUrl, options);
      await handler({
        event: "user_added",
        data: { user_id: BOT_USER_ID },
        broadcast: { channel_id: CHANNEL_ID },
      });
      expect(state.reportChannelRoomJoin).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ roomAllowed: false }),
      );
      await expect(state.reportChannelRoomJoin.mock.results[0]?.value).resolves.toEqual({
        kind: "skipped",
        reason: "room-not-allowed",
      });
      expect(requests.filter((request) => request.includes("/posts"))).toEqual([]);
      expect(state.enqueueSystemEvent).not.toHaveBeenCalled();
    });
  });
});
