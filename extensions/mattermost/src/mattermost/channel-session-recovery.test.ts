import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  buildMattermostChannelRecoveryHistory,
  recoverMattermostChannelSessionHistory,
} from "./channel-session-recovery.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

const channelId = "channel-1";
const sessionKey = "agent:main:mattermost:group:channel-1";
const botUserId = "agent-bot";

const runRef = {
  schemaVersion: 3,
  projectionKind: "run",
  conversationId: channelId,
  turnId: "input-1",
  runId: "run-1",
  agentId: "main",
  sessionKey,
  origin: "human",
  status: "completed",
  mainChannelId: channelId,
  mainRootPostId: "input-1",
  inputPostId: "input-1",
  activityRootPostId: "activity-root-1",
  attention: "routine",
};

function inputPost(overrides: Partial<MattermostPost> = {}): MattermostPost {
  return {
    id: "input-1",
    user_id: "human-1",
    channel_id: channelId,
    root_id: "",
    message: "Please continue the durable work",
    type: "",
    create_at: 100,
    update_at: 100,
    edit_at: 0,
    delete_at: 0,
    pending_post_id: "",
    file_ids: [],
    props: {},
    ...overrides,
  };
}

function answerPost(overrides: Partial<MattermostPost> = {}): MattermostPost {
  return {
    id: "answer-1",
    user_id: botUserId,
    channel_id: channelId,
    root_id: "input-1",
    message: "The durable answer",
    type: "",
    create_at: 200,
    update_at: 200,
    edit_at: 0,
    delete_at: 0,
    pending_post_id: "",
    file_ids: [],
    props: {},
    ...overrides,
  };
}

function commitPost(overrides: Partial<MattermostPost> = {}): MattermostPost {
  return {
    id: "commit-1",
    user_id: botUserId,
    channel_id: channelId,
    root_id: "input-1",
    message: "Answer committed",
    type: "",
    create_at: 300,
    update_at: 300,
    edit_at: 0,
    delete_at: 0,
    pending_post_id: "",
    file_ids: [],
    props: {
      octogee: {
        ...runRef,
        kind: "agent.answer-commit",
        itemId: "octogee:answer-commit",
        ordinal: 7,
        semanticVersion: 1,
        eventKey: "answer-commit:run-1",
        answer: {
          terminalOutcome: "completed",
          deliveryOutcome: "delivered",
          postIds: ["answer-1"],
          parts: [
            {
              postId: "answer-1",
              kind: "text",
              index: 0,
              rootPostId: "input-1",
              threadId: "input-1",
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

function recoveryArgs() {
  return {
    posts: [commitPost(), inputPost(), answerPost()],
    channelId,
    sessionKey,
    agentId: "main",
    botUserId,
    maxEntries: 20,
  };
}

describe("Mattermost channel session recovery", () => {
  it.each([
    [20, ["input-1", "answer-1", "second-root", "late-followup"]],
    [2, ["second-root", "late-followup"]],
    [1, ["late-followup"]],
    [0, []],
  ])("merges interleaved threads before applying the %i-entry limit", (maxEntries, expected) => {
    const posts = [
      ...recoveryArgs().posts,
      inputPost({ id: "second-root", create_at: 250, update_at: 250 }),
      inputPost({ id: "late-followup", root_id: "input-1", create_at: 350, update_at: 350 }),
    ];
    expect(
      buildMattermostChannelRecoveryHistory({ ...recoveryArgs(), posts, maxEntries }).map(
        (entry) => entry.messageId,
      ),
    ).toEqual(expected);
  });

  it("recovers a metadata-only SQLite session but leaves existing transcript and archived state authoritative", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mattermost-recovery-store-"));
    const storePath = path.join(root, "sessions.json");
    const sessionId = "materialized-session";
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const posts = recoveryArgs().posts;
    const request = vi.fn().mockResolvedValue({
      order: posts.map((post) => post.id),
      posts: Object.fromEntries(posts.map((post) => [post.id, post])),
    });
    const client: MattermostClient = {
      baseUrl: "https://mattermost.example.com",
      apiBaseUrl: "https://mattermost.example.com/api/v4",
      token: "test-token",
      request,
      fetchImpl: vi.fn(),
    };
    const params = {
      cfg,
      client,
      threadSessionScope: "channel" as const,
      chatKind: "group",
      currentPost: inputPost({ id: "next-input", create_at: 400 }),
      isControlCommand: false,
      channelId,
      sessionKey,
      agentId: "main",
      botUserId,
      historyLimit: 20,
    };
    const scope = { storePath, sessionKey, agentId: "main", sessionId };
    try {
      await upsertSessionEntry({ ...scope, entry: { sessionId, updatedAt: 1, archivedAt: 1 } });
      expect(await recoverMattermostChannelSessionHistory(params)).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
      await upsertSessionEntry({ ...scope, entry: { sessionId, updatedAt: 1 } });
      expect(await recoverMattermostChannelSessionHistory(params)).toHaveLength(2);
      expect(request).toHaveBeenCalledTimes(1);
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "live conversation" },
      });
      expect(await recoverMattermostChannelSessionHistory(params)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("orders an answer by delivery time when its commit arrives after another human input", () => {
    const followup = inputPost({
      id: "followup",
      root_id: "input-1",
      create_at: 250,
      update_at: 250,
    });
    const history = buildMattermostChannelRecoveryHistory({
      ...recoveryArgs(),
      posts: [...recoveryArgs().posts, followup],
    });
    expect(history.map((entry) => entry.messageId)).toEqual(["input-1", "answer-1", "followup"]);
  });

  it.each([
    ["input after commit", inputPost({ create_at: 350, update_at: 350 }), answerPost()],
    ["answer before input", inputPost({ create_at: 250, update_at: 250 }), answerPost()],
  ])("rejects noncausal answers: %s", (_label, input, answer) => {
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [input, answer, commitPost()],
      }).map((entry) => entry.sender),
    ).toEqual(["human-1"]);
  });

  it("reconstructs top-level human turns plus only exact sealed answer parts", () => {
    const activity = answerPost({
      id: "activity-1",
      message: "private tool output",
      create_at: 250,
      props: {
        octogee: {
          ...runRef,
          kind: "agent.activity",
          itemId: "tool-1",
          toolCallId: "call-1",
        },
      },
    });
    const uncommitted = answerPost({ id: "uncommitted-1", message: "uncommitted draft" });
    const forged = commitPost({ id: "forged", user_id: "human-1", message: "" });

    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [forged, activity, commitPost(), inputPost(), uncommitted, answerPost()],
      }),
    ).toEqual([
      {
        sender: "human-1",
        body: "Please continue the durable work",
        timestamp: 100,
        messageId: "input-1",
      },
      {
        sender: "OpenClaw",
        body: "The durable answer",
        timestamp: 200,
        messageId: "answer-1",
      },
    ]);
  });

  it.each([1, 20])("keeps multipart answers atomic at the %i-entry limit", (maxEntries) => {
    const second = answerPost({ id: "answer-2", message: "Second half", create_at: 220 });
    const marker = commitPost({
      props: {
        octogee: {
          ...runRef,
          kind: "agent.answer-commit",
          itemId: "octogee:answer-commit",
          ordinal: 7,
          semanticVersion: 1,
          eventKey: "answer-commit:run-1",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: ["answer-1", "answer-2"],
            parts: [
              { postId: "answer-1", kind: "text", index: 0, rootPostId: "input-1" },
              { postId: "answer-2", kind: "text", index: 1, rootPostId: "input-1" },
            ],
          },
        },
      },
    });

    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [marker, inputPost(), second, answerPost()],
        maxEntries,
      }).at(-1),
    ).toEqual({
      sender: "OpenClaw",
      body: "The durable answer\n\nSecond half",
      timestamp: 220,
      messageId: "answer-1",
    });
  });

  it.each([
    ["edited marker", { edit_at: 301 }],
    ["deleted marker", { delete_at: 301 }],
    ["marker with a file", { file_ids: ["file-1"] }],
    ["wrong marker text", { message: "Looks committed" }],
  ])("rejects an %s and its referenced answer", (_label, markerOverride) => {
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(markerOverride), inputPost(), answerPost()],
      }),
    ).toEqual([
      {
        sender: "human-1",
        body: "Please continue the durable work",
        timestamp: 100,
        messageId: "input-1",
      },
    ]);
  });

  it.each(["edit_at", "delete_at", "file_ids", "pending_post_id", "props"])(
    "rejects a marker whose canonical REST %s field is missing",
    (field) => {
      expect(
        buildMattermostChannelRecoveryHistory({
          ...recoveryArgs(),
          posts: [commitPost({ [field]: undefined }), inputPost(), answerPost()],
        }),
      ).toHaveLength(1);
    },
  );

  it.each(["edit_at", "delete_at", "file_ids", "pending_post_id", "props"])(
    "rejects an answer whose canonical REST %s field is missing",
    (field) => {
      expect(
        buildMattermostChannelRecoveryHistory({
          ...recoveryArgs(),
          posts: [commitPost(), inputPost(), answerPost({ [field]: undefined })],
        }),
      ).toHaveLength(1);
    },
  );

  it("accepts persisted Mattermost idempotency keys on human, answer, and commit posts", () => {
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [
          commitPost({ pending_post_id: "commit-request-key" }),
          inputPost({ pending_post_id: "input-request-key" }),
          answerPost({ pending_post_id: "answer-request-key" }),
        ],
      }),
    ).toHaveLength(2);
  });

  it("rejects an answer edited after its immutable commit", () => {
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(), inputPost(), answerPost({ edit_at: 301 })],
      }),
    ).toHaveLength(1);
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(), inputPost(), answerPost({ edit_at: 299 })],
      }),
    ).toHaveLength(2);
  });

  it("rejects a commit atomically for the wrong root, identity, or activity part", () => {
    const invalidParts = [
      answerPost({ root_id: "other-root" }),
      answerPost({ props: { octogee: { ...runRef, runId: "other-run" } } }),
      answerPost({
        props: { octogee: { ...runRef, kind: "agent.activity", itemId: "tool-1" } },
      }),
    ];
    for (const invalid of invalidParts) {
      expect(
        buildMattermostChannelRecoveryHistory({
          ...recoveryArgs(),
          posts: [commitPost(), inputPost(), invalid],
        }),
      ).toHaveLength(1);
    }
  });

  it("keeps partial delivery as evidence rather than clean context", () => {
    const partial = commitPost({
      props: {
        octogee: {
          ...runRef,
          status: "failed",
          kind: "agent.answer-commit",
          itemId: "octogee:answer-commit",
          ordinal: 7,
          semanticVersion: 1,
          eventKey: "answer-commit:run-1",
          answer: {
            terminalOutcome: "failed",
            deliveryOutcome: "partial",
            postIds: ["answer-1"],
            parts: [{ postId: "answer-1", kind: "text", index: 0 }],
          },
        },
      },
    });
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [partial, inputPost(), answerPost()],
      }),
    ).toHaveLength(1);
  });

  it("rejects conflicting duplicate commits for one run", () => {
    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [
          commitPost(),
          commitPost({ id: "commit-2", create_at: 301 }),
          inputPost(),
          answerPost(),
        ],
      }),
    ).toHaveLength(1);
  });

  it("rejects every commit that collides on one answer post id", () => {
    const secondInput = inputPost({
      id: "input-2",
      root_id: "input-1",
      message: "A second run",
      create_at: 150,
      update_at: 150,
    });
    const collidingCommit = commitPost({
      id: "commit-2",
      create_at: 400,
      props: {
        octogee: {
          ...runRef,
          runId: "run-2",
          inputPostId: "input-2",
          kind: "agent.answer-commit",
          itemId: "octogee:answer-commit",
          ordinal: 9,
          semanticVersion: 1,
          eventKey: "answer-commit:run-2",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: ["answer-1"],
            parts: [{ postId: "answer-1", kind: "text", index: 0 }],
          },
        },
      },
    });

    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(), collidingCommit, inputPost(), secondInput, answerPost()],
      }).filter((entry) => entry.sender === "OpenClaw"),
    ).toEqual([]);
  });

  it("uses the latest distinct delivered run as the recovered state for one turn root", () => {
    const retryAnswer = answerPost({
      id: "answer-2",
      message: "Revised durable answer",
      create_at: 350,
    });
    const retryCommit = commitPost({
      id: "commit-2",
      create_at: 400,
      props: {
        octogee: {
          ...runRef,
          runId: "run-2",
          kind: "agent.answer-commit",
          itemId: "octogee:answer-commit",
          ordinal: 9,
          semanticVersion: 1,
          eventKey: "answer-commit:run-2",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: ["answer-2"],
            parts: [{ postId: "answer-2", kind: "text", index: 0 }],
          },
        },
      },
    });

    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(), retryCommit, inputPost(), answerPost(), retryAnswer],
      })[1]?.body,
    ).toBe("Revised durable answer");
  });

  it("preserves nested human follow-up text and its separately committed answer in timeline order", () => {
    const followUp = inputPost({
      id: "input-2",
      root_id: "input-1",
      message: "Please revise that answer",
      create_at: 350,
    });
    const followUpAnswer = answerPost({
      id: "answer-2",
      message: "The revised durable answer",
      create_at: 400,
    });
    const followUpCommit = commitPost({
      id: "commit-2",
      create_at: 450,
      props: {
        octogee: {
          ...runRef,
          runId: "run-2",
          inputPostId: "input-2",
          kind: "agent.answer-commit",
          itemId: "octogee:answer-commit",
          ordinal: 9,
          semanticVersion: 1,
          eventKey: "answer-commit:run-2",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: ["answer-2"],
            parts: [{ postId: "answer-2", kind: "text", index: 0, rootPostId: "input-1" }],
          },
        },
      },
    });

    expect(
      buildMattermostChannelRecoveryHistory({
        ...recoveryArgs(),
        posts: [commitPost(), followUpCommit, inputPost(), followUp, answerPost(), followUpAnswer],
      }).map(({ sender, body }) => ({ sender, body })),
    ).toEqual([
      { sender: "human-1", body: "Please continue the durable work" },
      { sender: "OpenClaw", body: "The durable answer" },
      { sender: "human-1", body: "Please revise that answer" },
      { sender: "OpenClaw", body: "The revised durable answer" },
    ]);
  });

  it("reads one bounded page before a fresh top-level human turn and leaves SQLite authoritative", async () => {
    const fetchChannelPosts = vi.fn().mockResolvedValue({
      messages: [commitPost(), answerPost()],
      hasMore: true,
    });
    const fetchPost = vi.fn().mockResolvedValue(inputPost());
    const sessionHasState = vi.fn().mockReturnValue(false);
    const dependencies = { fetchChannelPosts, fetchPost, sessionHasState };
    const currentPost = inputPost({ id: "input-2", message: "What happened?", create_at: 400 });

    await expect(
      recoverMattermostChannelSessionHistory(
        {
          cfg: {} as OpenClawConfig,
          client: {} as MattermostClient,
          threadSessionScope: "channel",
          chatKind: "group",
          currentPost,
          isControlCommand: false,
          channelId,
          sessionKey,
          agentId: "main",
          botUserId,
          historyLimit: 50,
        },
        dependencies,
      ),
    ).resolves.toHaveLength(2);
    expect(fetchChannelPosts).toHaveBeenCalledWith(expect.anything(), channelId, {
      before: "input-2",
      limit: 200,
    });
    expect(fetchPost).toHaveBeenCalledWith(expect.anything(), "input-1");

    sessionHasState.mockReturnValue(true);
    fetchChannelPosts.mockClear();
    await expect(
      recoverMattermostChannelSessionHistory(
        {
          cfg: {} as OpenClawConfig,
          client: {} as MattermostClient,
          threadSessionScope: "channel",
          chatKind: "group",
          currentPost,
          isControlCommand: false,
          channelId,
          sessionKey,
          agentId: "main",
          botUserId,
          historyLimit: 50,
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();
    expect(fetchChannelPosts).not.toHaveBeenCalled();
  });

  it("recovers the same channel session for a new run started by a nested human reply", async () => {
    const fetchChannelPosts = vi.fn().mockResolvedValue({
      messages: [commitPost(), answerPost()],
      hasMore: false,
    });
    const fetchPost = vi.fn().mockResolvedValue(inputPost());

    await expect(
      recoverMattermostChannelSessionHistory(
        {
          cfg: {} as OpenClawConfig,
          client: {} as MattermostClient,
          threadSessionScope: "channel",
          chatKind: "group",
          currentPost: inputPost({
            id: "input-2",
            root_id: "input-1",
            message: "Follow up inside this turn",
            create_at: 400,
          }),
          isControlCommand: false,
          channelId,
          sessionKey,
          agentId: "main",
          botUserId,
          historyLimit: 50,
        },
        { fetchChannelPosts, fetchPost, sessionHasState: () => false },
      ),
    ).resolves.toHaveLength(2);
    expect(fetchChannelPosts).toHaveBeenCalledWith(expect.anything(), channelId, {
      before: "input-2",
      limit: 200,
    });
    expect(fetchPost).toHaveBeenCalledWith(expect.anything(), "input-1");
  });

  it("fails the cold turn when required Mattermost recovery is unavailable", async () => {
    await expect(
      recoverMattermostChannelSessionHistory(
        {
          cfg: {} as OpenClawConfig,
          client: {} as MattermostClient,
          threadSessionScope: "channel",
          chatKind: "group",
          currentPost: inputPost({ id: "input-2", create_at: 400 }),
          isControlCommand: false,
          channelId,
          sessionKey,
          agentId: "main",
          botUserId,
          historyLimit: 50,
        },
        {
          fetchChannelPosts: vi.fn().mockRejectedValue(new Error("Mattermost unavailable")),
          fetchPost: vi.fn(),
          sessionHasState: () => false,
        },
      ),
    ).rejects.toThrow("Mattermost unavailable");
  });

  it.each([
    ["thread-scoped", { threadSessionScope: "thread" as const }],
    ["direct", { chatKind: "direct" }],
    ["control command", { isControlCommand: true }],
    ["noncanonical key", { sessionKey: "agent:main:mattermost:group:other" }],
  ])("does not recover %s input", async (_label, override) => {
    const fetchChannelPosts = vi.fn();
    const sessionHasState = vi.fn();
    await expect(
      recoverMattermostChannelSessionHistory(
        {
          cfg: {} as OpenClawConfig,
          client: {} as MattermostClient,
          threadSessionScope: "channel",
          chatKind: "group",
          currentPost: inputPost({ id: "input-2" }),
          isControlCommand: false,
          channelId,
          sessionKey,
          agentId: "main",
          botUserId,
          historyLimit: 50,
          ...override,
        },
        { fetchChannelPosts, fetchPost: vi.fn(), sessionHasState },
      ),
    ).resolves.toBeUndefined();
    expect(sessionHasState).not.toHaveBeenCalled();
    expect(fetchChannelPosts).not.toHaveBeenCalled();
  });
});
