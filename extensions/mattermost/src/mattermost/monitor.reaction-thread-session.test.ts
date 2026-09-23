// Mattermost tests cover reaction thread placement through the production REST lookup.
import { once } from "node:events";
import { createServer } from "node:http";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMattermostClient } from "./client.js";
import { createMattermostReactionHandler } from "./monitor-reactions.js";
import { createMattermostMonitorResources } from "./monitor-resources.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import type { OpenClawConfig } from "./runtime-api.js";

const LOOPBACK_TOKEN = "mattermost-loopback-thread-reaction-token";
const CHANNEL_ID = "chan-1";
const BASE_SESSION_KEY = `mattermost:default:channel:${CHANNEL_ID}`;

const loopbackState = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  runtimeCore: undefined as unknown,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => loopbackState.runtimeCore,
  getOptionalMattermostRuntime: () => loopbackState.runtimeCore,
}));

const openServers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of openServers.splice(0)) {
    server.close();
  }
  loopbackState.enqueueSystemEvent.mockClear();
});

type LoopbackPost = { id: string; channel_id?: string; user_id?: string; root_id?: string };

async function startLoopbackMattermost(post: LoopbackPost | null, channelType: "O" | "P" = "O") {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(`${request.method ?? "GET"} ${url}`);
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${LOOPBACK_TOKEN}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    if (url === `/api/v4/channels/${CHANNEL_ID}`) {
      response.end(
        JSON.stringify({
          id: CHANNEL_ID,
          name: "town-square",
          display_name: "Town Square",
          team_id: "team-1",
          type: channelType,
        }),
      );
      return;
    }
    if (url === "/api/v4/users/user-1") {
      response.end(JSON.stringify({ id: "user-1", username: "alice", update_at: 1 }));
      return;
    }
    if (post && url === `/api/v4/posts/${post.id}`) {
      response.end(
        JSON.stringify({
          channel_id: CHANNEL_ID,
          user_id: "user-1",
          create_at: 1_714_000_000_000,
          ...post,
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ message: "unknown loopback endpoint" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a Mattermost loopback TCP address");
  }
  const entry = { close: () => server.close() };
  openServers.push(entry);
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function runReactionThroughMonitor(params: {
  baseUrl: string;
  postId: string;
  baseSessionKey?: string;
  threadSessionScope?: "thread" | "channel";
}) {
  const baseSessionKey = params.baseSessionKey ?? BASE_SESSION_KEY;
  const pluginRuntime = createPluginRuntimeMock();
  const runtimeCore = {
    ...pluginRuntime,
    channel: {
      ...pluginRuntime.channel,
      routing: {
        ...pluginRuntime.channel.routing,
        resolveAgentRoute: () => ({
          accountId: "default",
          agentId: "main",
          lastRoutePolicy: "main" as const,
          mainSessionKey: baseSessionKey,
          sessionKey: baseSessionKey,
        }),
      },
    },
    system: {
      ...pluginRuntime.system,
      enqueueSystemEvent: loopbackState.enqueueSystemEvent,
    },
  };
  loopbackState.runtimeCore = runtimeCore;

  // The production REST client, resource cache, and reaction handler all run here; only
  // the Mattermost transport and the agent runtime are replaced.
  const client = createMattermostClient({
    baseUrl: params.baseUrl,
    botToken: LOOPBACK_TOKEN,
    allowPrivateNetwork: true,
  });
  const resources = createMattermostMonitorResources({
    accountId: "default",
    callbackUrl: "http://127.0.0.1:9/mattermost/callback",
    client,
    logger: { debug: () => {} },
    mediaMaxBytes: 1024,
    saveRemoteMedia: async () => ({ path: "/tmp/mattermost-loopback-media" }),
    mediaKindFromMime: () => null,
  });
  const accountConfig = {
    dmPolicy: "open",
    groupPolicy: "open",
    threadSessionScope: params.threadSessionScope,
  } as const;
  const cfg = {
    channels: { mattermost: { enabled: true, ...accountConfig } },
  } as OpenClawConfig;
  const monitor = {
    account: {
      accountId: "default",
      baseUrl: params.baseUrl,
      botToken: LOOPBACK_TOKEN,
      config: accountConfig,
    },
    botUserId: "bot-user",
    cfg,
    core: runtimeCore,
    groupPolicy: "open",
    pairing: { readAllowFromStore: async () => [] },
    resources,
    logVerboseMessage: () => {},
    logDebugMessage: () => {},
  } as unknown as MattermostMonitorContext;

  const handler = createMattermostReactionHandler(monitor);
  await handler({
    event: "reaction_added",
    data: {
      reaction: JSON.stringify({
        user_id: "user-1",
        post_id: params.postId,
        emoji_name: "thumbsup",
      }),
      channel_id: CHANNEL_ID,
    },
    broadcast: { channel_id: CHANNEL_ID },
  } as MattermostEventPayload);
}

describe("mattermost reaction thread placement", () => {
  it("routes a thread-reply reaction through the production post lookup", async () => {
    const loopback = await startLoopbackMattermost({
      id: "post-reply",
      root_id: "root-1",
    });

    await runReactionThroughMonitor({ baseUrl: loopback.baseUrl, postId: "post-reply" });

    expect(loopback.requests).toContain("GET /api/v4/posts/post-reply");
    expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost reaction added"),
      expect.objectContaining({
        sessionKey: `${BASE_SESSION_KEY}:thread:root-1`,
        contextKey: "mattermost:reaction:post-reply:thumbsup:user-1:added",
      }),
    );
  });

  it("keeps the parent channel session when the production post lookup fails", async () => {
    const loopback = await startLoopbackMattermost(null);

    await runReactionThroughMonitor({ baseUrl: loopback.baseUrl, postId: "post-unknown" });

    expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Mattermost reaction added"),
      expect.objectContaining({ sessionKey: BASE_SESSION_KEY }),
    );
  });

  it.each([
    { channelType: "O", kind: "channel", lookup: "succeeds" },
    { channelType: "O", kind: "channel", lookup: "fails" },
    { channelType: "P", kind: "group", lookup: "succeeds" },
    { channelType: "P", kind: "group", lookup: "fails" },
  ] as const)(
    "keeps channel-scoped $kind reactions in the base session when post lookup $lookup",
    async ({ channelType, kind, lookup }) => {
      const postId = "post-reply";
      const loopback = await startLoopbackMattermost(
        lookup === "succeeds" ? { id: postId, root_id: "root-1" } : null,
        channelType,
      );
      const baseSessionKey = `mattermost:default:${kind}:${CHANNEL_ID}`;

      await runReactionThroughMonitor({
        baseUrl: loopback.baseUrl,
        postId,
        baseSessionKey,
        threadSessionScope: "channel",
      });

      expect(loopback.requests).toContain(`GET /api/v4/posts/${postId}`);
      expect(loopback.requests).toContain(`GET /api/v4/channels/${CHANNEL_ID}`);
      expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(loopbackState.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Mattermost reaction added"),
        expect.objectContaining({
          sessionKey: baseSessionKey,
          contextKey: `mattermost:reaction:${postId}:thumbsup:user-1:added`,
        }),
      );
    },
  );
});
