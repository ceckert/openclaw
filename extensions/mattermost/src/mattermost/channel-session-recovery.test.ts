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
        timestamp: 300,
        messageId: "answer-1",
      },
    ]);
  });

  it("joins ordered multipart answer posts into one assistant history entry", () => {
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
      })[1],
    ).toEqual({
      sender: "OpenClaw",
      body: "The durable answer\n\nSecond half",
      timestamp: 300,
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
      create_at: 350,
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
    const sessionExists = vi.fn().mockReturnValue(false);
    const dependencies = { fetchChannelPosts, fetchPost, sessionExists };
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

    sessionExists.mockReturnValue(true);
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
        { fetchChannelPosts, fetchPost, sessionExists: () => false },
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
          sessionExists: () => false,
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
    const sessionExists = vi.fn();
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
        { fetchChannelPosts, fetchPost: vi.fn(), sessionExists },
      ),
    ).resolves.toBeUndefined();
    expect(sessionExists).not.toHaveBeenCalled();
    expect(fetchChannelPosts).not.toHaveBeenCalled();
  });
});
