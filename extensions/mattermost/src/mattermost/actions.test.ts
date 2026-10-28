import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MattermostRuntime from "../runtime.js";
import { runMattermostMessageAction, type MattermostMessageActionParams } from "./actions.js";
import type * as MattermostRuntimeApi from "./runtime-api.js";

const TOKEN = "mattermost-loopback-actions-token";
const CHANNEL_ID = "chan1chan1chan1chan1chan1c";

const state = vi.hoisted(() => ({
  runtimeCore: undefined as unknown,
  saveRemoteMedia: vi.fn(async () => ({
    id: "media-1",
    path: "/tmp/mattermost-download",
    size: 12,
    contentType: "image/png",
    fileName: "shot.png",
  })),
  loadOutboundMediaFromUrl: vi.fn(async (mediaUrl: string) => ({
    buffer: Buffer.from("png-bytes"),
    fileName: mediaUrl.split("/").at(-1),
    contentType: "image/png",
  })),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntime>()),
  getMattermostRuntime: () => state.runtimeCore,
  getOptionalMattermostRuntime: () => state.runtimeCore,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntimeApi>()),
  loadOutboundMediaFromUrl: state.loadOutboundMediaFromUrl,
}));

afterEach(() => {
  state.saveRemoteMedia.mockClear();
  state.loadOutboundMediaFromUrl.mockClear();
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
    "GET /api/v4/users/user-2": { id: "user-2", username: "bob" },
    "GET /api/v4/users/user-3": { id: "user-3", username: "mallory" },
    [`GET /api/v4/channels/${CHANNEL_ID}/members/user-2`]: {
      channel_id: CHANNEL_ID,
      user_id: "user-2",
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
    "POST /api/v4/teams/team-1/posts/search": {
      order: ["post-leak", ...posts.order],
      posts: {
        ...posts.posts,
        "post-leak": { id: "post-leak", channel_id: "chan-other", message: "release elsewhere" },
      },
    },
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
    "POST /api/v4/files": { file_infos: [{ id: "file-up" }] },
    "POST /api/v4/posts": { id: "post-upload", channel_id: CHANNEL_ID, message: "shot" },
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

function loopbackConfig(baseUrl: string, groupPolicy: "open" | "allowlist" = "open") {
  return {
    channels: {
      mattermost: {
        enabled: true,
        baseUrl,
        botToken: TOKEN,
        groupPolicy,
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
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
    cfg: loopbackConfig(baseUrl),
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

const foreignAccountContext: MattermostMessageActionParams["context"] = {
  conversationReadOrigin: "delegated",
  requesterAccountId: "other-account",
  requesterSenderId: "user-1",
  toolContext: { currentChannelProvider: "mattermost", currentChannelId: `channel:${CHANNEL_ID}` },
};

const parse = (result: Awaited<ReturnType<typeof runMattermostMessageAction>>) => {
  const content = result.content[0];
  return JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
};

const requestKeys = (requests: Request[]) =>
  requests.map((entry) => `${entry.method} ${entry.url}`);

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
      expect(requestKeys(requests)).toContain(expected);
    });
  });

  it("refuses delegated writes to posts outside the authorized conversation", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      await expect(
        run(baseUrl, "delete", { messageId: "post-other", to: `channel:${CHANNEL_ID}` }),
      ).rejects.toThrow("different conversation");
    });
  });

  it.each(["edit", "delete", "pin", "unpin", "upload-file"] as const)(
    "%s stops at a revoked caller before any provider request",
    async (action) => {
      await withLoopbackMattermost(async (baseUrl, requests) => {
        await expect(
          run(
            baseUrl,
            action,
            {
              messageId: "post-1",
              to: `channel:${CHANNEL_ID}`,
              message: "edited",
              filePath: "/tmp/workspace/a.png",
            },
            {
              context: {
                conversationReadOrigin: "direct-operator",
                assertDirectAdapterHandoff: () => {
                  throw new Error("message action caller is no longer active");
                },
              },
              mediaLocalRoots: ["/tmp/workspace"],
            },
          ),
        ).rejects.toThrow("message action caller is no longer active");
        expect(requests).toEqual([]);
      });
    },
  );

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

  it("scopes delegated search to the authorized channel and drops posts from elsewhere", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const result = parse(
        await run(baseUrl, "search", { query: "release", channelId: CHANNEL_ID, limit: 5 }),
      );
      const search = requests.find((entry) => entry.url.endsWith("/posts/search"));
      expect(JSON.parse(search?.body ?? "{}")).toMatchObject({
        terms: "in:deploys release",
        per_page: 5,
      });
      expect(result).toMatchObject({ ok: true, teamId: "team-1", channelId: CHANNEL_ID });
      expect((result.messages as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
        "post-2",
        "post-1",
      ]);
    });
  });

  it("rejects delegated searches that omit the channel or carry their own in: scope", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await expect(run(baseUrl, "search", { query: "release" })).rejects.toThrow(
        "requires a channel target",
      );
      await expect(
        run(baseUrl, "search", { query: "in:other release", channelId: CHANNEL_ID }),
      ).rejects.toThrow("remove in: operators");
      await expect(
        run(baseUrl, "search", { query: "release -in:deploys", channelId: CHANNEL_ID }),
      ).rejects.toThrow("remove in: operators");
      expect(requests).toEqual([]);
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
      expect(requestKeys(requests)).toContain("POST /api/v4/teams/team-1/posts/search");
    });
  });

  it("returns member, channel and emoji details", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      expect(parse(await run(baseUrl, "member-info", {}))).toMatchObject({
        user: { id: "user-1", username: "alice", displayName: "Alice Lee", isBot: false },
      });
      expect(parse(await run(baseUrl, "member-info", { userId: "user-2" }))).toMatchObject({
        user: { id: "user-2", username: "bob" },
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

  it("refuses member info for users outside the current conversation", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await expect(run(baseUrl, "member-info", { userId: "user-3" })).rejects.toThrow(
        "limited to members of the current conversation",
      );
      expect(requestKeys(requests)).toEqual([`GET /api/v4/channels/${CHANNEL_ID}/members/user-3`]);
    });
  });

  it.each([
    { action: "member-info" as const, params: {} },
    { action: "emoji-list" as const, params: { limit: 5 } },
    { action: "channel-info" as const, params: { target: `channel:${CHANNEL_ID}` } },
    { action: "download-file" as const, params: { fileId: "file-1" } },
  ])(
    "$action refuses a delegated caller from another account before any request",
    async ({ action, params }) => {
      await withLoopbackMattermost(async (baseUrl, requests) => {
        await expect(
          run(baseUrl, action, params, { context: foreignAccountContext }),
        ).rejects.toThrow("require the current Mattermost account");
        expect(requests).toEqual([]);
      });
    },
  );

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

  it("uploads a file into a post in the authorized channel", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const mediaReadFile = vi.fn(async () => Buffer.from("x"));
      const result = parse(
        await run(
          baseUrl,
          "upload-file",
          { to: `channel:${CHANNEL_ID}`, filePath: "/tmp/workspace/a.png", message: "shot" },
          { mediaLocalRoots: ["/tmp/workspace"], mediaReadFile },
        ),
      );
      expect(state.loadOutboundMediaFromUrl).toHaveBeenCalledExactlyOnceWith(
        "/tmp/workspace/a.png",
        expect.objectContaining({ mediaLocalRoots: ["/tmp/workspace"], mediaReadFile }),
      );
      const post = requests.find((entry) => entry.url === "/api/v4/posts");
      expect(JSON.parse(post?.body ?? "{}")).toEqual({
        channel_id: CHANNEL_ID,
        message: "shot",
        file_ids: ["file-up"],
      });
      expect(result).toMatchObject({ ok: true, messageId: "post-upload", channelId: CHANNEL_ID });
    });
  });

  it("refuses a delegated upload to a channel the conversation cannot read before uploading", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await expect(
        run(
          baseUrl,
          "upload-file",
          { to: "channel:chan-other", filePath: "/tmp/workspace/a.png" },
          { cfg: loopbackConfig(baseUrl, "allowlist"), mediaLocalRoots: ["/tmp/workspace"] },
        ),
      ).rejects.toThrow("not allowed");
      expect(state.loadOutboundMediaFromUrl).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    });
  });
});
