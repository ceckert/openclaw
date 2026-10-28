import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MattermostRuntime from "../runtime.js";
import { runMattermostMessageAction, type MattermostMessageActionParams } from "./actions.js";
import type * as MattermostSend from "./send.js";

const TOKEN = "mattermost-loopback-actions-token";
const CHANNEL_ID = "chan-1";

const state = vi.hoisted(() => ({
  runtimeCore: undefined as unknown,
  saveRemoteMedia: vi.fn(async () => ({
    id: "media-1",
    path: "/tmp/mattermost-download",
    size: 12,
    contentType: "image/png",
    fileName: "shot.png",
  })),
  sendMessageMattermost: vi.fn(async () => ({ messageId: "post-upload", channelId: CHANNEL_ID })),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntime>()),
  getMattermostRuntime: () => state.runtimeCore,
  getOptionalMattermostRuntime: () => state.runtimeCore,
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostSend>()),
  sendMessageMattermost: state.sendMessageMattermost,
}));

afterEach(() => {
  state.saveRemoteMedia.mockClear();
  state.sendMessageMattermost.mockClear();
});

type Request = { method: string; url: string; body?: string };

async function withLoopbackMattermost(
  body: (baseUrl: string, requests: Request[]) => Promise<void>,
  options: { channelType?: string } = {},
) {
  const requests: Request[] = [];
  const posts = {
    order: ["post-2", "post-1"],
    posts: {
      "post-1": {
        id: "post-1",
        channel_id: CHANNEL_ID,
        message: "older",
        create_at: 1_714_000_000_000,
      },
      "post-2": {
        id: "post-2",
        channel_id: CHANNEL_ID,
        message: "newer",
        create_at: 1_714_000_001_000,
      },
    },
  };
  const routes: Record<string, unknown> = {
    "GET /api/v4/users/me": { id: "bot-user" },
    "GET /api/v4/users/bot-user/teams": [{ id: "team-1" }],
    "GET /api/v4/users/user-1": {
      id: "user-1",
      username: "alice",
      first_name: "Alice",
      last_name: "Lee",
      position: "Builder",
      roles: "system_user",
      is_bot: false,
    },
    [`GET /api/v4/channels/${CHANNEL_ID}`]: {
      id: CHANNEL_ID,
      name: "deploys",
      display_name: "Deploys",
      type: options.channelType ?? "O",
      team_id: "team-1",
      purpose: "Ship things",
    },
    [`GET /api/v4/channels/${CHANNEL_ID}/stats`]: { member_count: 7 },
    [`GET /api/v4/channels/${CHANNEL_ID}/pinned`]: posts,
    "GET /api/v4/posts/post-1": posts.posts["post-1"],
    "GET /api/v4/posts/post-other": { id: "post-other", channel_id: "chan-other" },
    "PUT /api/v4/posts/post-1/patch": { id: "post-1", message: "edited" },
    "DELETE /api/v4/posts/post-1": { status: "OK" },
    "POST /api/v4/posts/post-1/pin": { status: "OK" },
    "POST /api/v4/posts/post-1/unpin": { status: "OK" },
    "POST /api/v4/teams/team-1/posts/search": posts,
    "GET /api/v4/emoji?page=0&per_page=5&sort=name": [
      { id: "e1", name: "partyparrot" },
      { id: "e2", name: "shipit" },
    ],
    "GET /api/v4/files/file-1/info": {
      id: "file-1",
      name: "shot.png",
      mime_type: "image/png",
      size: 12,
      post_id: "post-1",
    },
  };
  await withServer(
    (request, response) => {
      const key = `${request.method ?? "GET"} ${request.url ?? ""}`;
      let requestBody = "";
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "GET",
          url: request.url ?? "",
          body: requestBody,
        });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        const payload = Object.hasOwn(routes, key) ? routes[key] : undefined;
        response.writeHead(payload ? 200 : 404);
        response.end(JSON.stringify(payload ?? { message: `unknown loopback route ${key}` }));
      });
    },
    (baseUrl) => body(baseUrl, requests),
  );
}

function run(
  baseUrl: string,
  action: MattermostMessageActionParams["action"],
  params: Record<string, unknown>,
  overrides: Partial<MattermostMessageActionParams> = {},
) {
  const runtimeCore = createPluginRuntimeMock();
  runtimeCore.channel.media.saveRemoteMedia = state.saveRemoteMedia;
  state.runtimeCore = runtimeCore;
  return runMattermostMessageAction({
    action,
    params,
    cfg: {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl,
          botToken: TOKEN,
          groupPolicy: "open",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    },
    accountId: "default",
    context: {
      conversationReadOrigin: "delegated",
      requesterAccountId: "default",
      requesterSenderId: "user-1",
      toolContext: {
        currentChannelProvider: "mattermost",
        currentChannelId: `channel:${CHANNEL_ID}`,
      },
    },
    ...overrides,
  });
}

const parse = (result: Awaited<ReturnType<typeof runMattermostMessageAction>>) => {
  const content = result.content[0];
  return JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
};

describe("mattermost message actions", () => {
  it.each([
    { action: "edit" as const, expected: "PUT /api/v4/posts/post-1/patch" },
    { action: "delete" as const, expected: "DELETE /api/v4/posts/post-1" },
    { action: "pin" as const, expected: "POST /api/v4/posts/post-1/pin" },
    { action: "unpin" as const, expected: "POST /api/v4/posts/post-1/unpin" },
  ])("$action writes a post inside the authorized conversation", async ({ action, expected }) => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await run(baseUrl, action, {
        messageId: "post-1",
        to: `channel:${CHANNEL_ID}`,
        message: "edited",
      });
      expect(requests.map((entry) => `${entry.method} ${entry.url}`)).toContain(expected);
    });
  });

  it("refuses delegated writes to posts outside the authorized conversation", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      await expect(
        run(baseUrl, "delete", { messageId: "post-other", to: `channel:${CHANNEL_ID}` }),
      ).rejects.toThrow("different conversation");
    });
  });

  it("lists pinned posts with normalized timestamps", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const result = parse(await run(baseUrl, "list-pins", { target: `channel:${CHANNEL_ID}` }));
      expect(result).toMatchObject({
        ok: true,
        channelId: CHANNEL_ID,
        messages: [
          expect.objectContaining({ id: "post-2", timestampMs: 1_714_000_001_000 }),
          expect.objectContaining({ id: "post-1" }),
        ],
      });
    });
  });

  it("scopes delegated search to the channel and rejects team-wide search", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const result = parse(
        await run(baseUrl, "search", {
          query: "release",
          target: `channel:${CHANNEL_ID}`,
          limit: 5,
        }),
      );
      const search = requests.find((entry) => entry.url.endsWith("/posts/search"));
      expect(JSON.parse(search?.body ?? "{}")).toMatchObject({
        terms: "in:deploys release",
        per_page: 5,
      });
      expect(result).toMatchObject({ ok: true, teamId: "team-1", channelId: CHANNEL_ID });
      await expect(run(baseUrl, "search", { query: "release" })).rejects.toThrow(
        "requires a channel target",
      );
    });
  });

  it("lets operators search the bot's team without a channel", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await run(
        baseUrl,
        "search",
        { query: "release" },
        { context: { conversationReadOrigin: "direct-operator" } },
      );
      expect(requests.map((entry) => `${entry.method} ${entry.url}`)).toContain(
        "POST /api/v4/teams/team-1/posts/search",
      );
    });
  });

  it("returns member, channel and emoji details", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      expect(parse(await run(baseUrl, "member-info", {}))).toMatchObject({
        user: { id: "user-1", username: "alice", displayName: "Alice Lee", isBot: false },
      });
      expect(
        parse(await run(baseUrl, "channel-info", { target: `channel:${CHANNEL_ID}` })),
      ).toMatchObject({
        channel: { id: CHANNEL_ID, name: "deploys", purpose: "Ship things", memberCount: 7 },
      });
      expect(parse(await run(baseUrl, "emoji-list", { limit: 5 }))).toMatchObject({
        emoji: [
          { id: "e1", name: "partyparrot" },
          { id: "e2", name: "shipit" },
        ],
      });
    });
  });

  it("downloads a file after authorizing its post", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const result = parse(await run(baseUrl, "download-file", { fileId: "file-1" }));
      expect(state.saveRemoteMedia).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: `${baseUrl}/api/v4/files/file-1`,
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }),
      );
      expect(result).toMatchObject({ ok: true, path: "/tmp/mattermost-download", size: 12 });
    });
  });

  it("uploads a file through the send path with upload required", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const mediaReadFile = vi.fn(async () => Buffer.from("x"));
      const result = parse(
        await run(
          baseUrl,
          "upload-file",
          { to: `channel:${CHANNEL_ID}`, filePath: "/tmp/workspace/a.png", message: "shot" },
          { mediaLocalRoots: ["/tmp/workspace"], mediaReadFile },
        ),
      );
      expect(state.sendMessageMattermost).toHaveBeenCalledExactlyOnceWith(
        `channel:${CHANNEL_ID}`,
        "shot",
        expect.objectContaining({
          mediaUrl: "/tmp/workspace/a.png",
          mediaLocalRoots: ["/tmp/workspace"],
          mediaReadFile,
          requireMediaUpload: true,
        }),
      );
      expect(result).toMatchObject({ ok: true, messageId: "post-upload" });
    });
  });
});
