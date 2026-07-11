import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentActivityPublisher,
  type AgentActivityAppend,
  type AgentActivitySink,
} from "./publisher.js";

const baseRef = {
  conversationId: "channel-1",
  turnId: "post-root",
  runId: "run-1",
  agentId: "octogee-alice-coach",
  sessionKey: "agent:octogee-alice-coach:mattermost:channel:channel-1",
  origin: "human" as const,
  mainChannelId: "channel-1",
  mainRootPostId: "post-root",
};

function createSink() {
  const appends: AgentActivityAppend[] = [];
  const sink: AgentActivitySink = {
    append: vi.fn(async (item) => {
      appends.push(item);
      return { postIds: [] };
    }),
  };
  return { appends, sink };
}

function expectedEventKey(itemId: string, semanticVersion = 1): string {
  return createHash("sha256")
    .update(`v1\nchannel-1\nrun-1\n${itemId}\n${semanticVersion}`)
    .digest("hex");
}

describe("createAgentActivityPublisher", () => {
  it("publishes start, completed semantic items, and finalization", async () => {
    const { appends, sink } = createSink();
    const publisher = createAgentActivityPublisher({
      ref: baseRef,
      sink,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });

    await publisher.start();
    await publisher.onItemEvent({
      itemId: "commentary-1",
      kind: "preamble",
      progressText: "First thought.",
    });
    await publisher.onItemEvent({
      itemId: "commentary-1",
      kind: "preamble",
      progressText: "First thought. More detail.",
    });
    await publisher.onItemEvent({
      itemId: "tool:call-1",
      toolCallId: "call-1",
      kind: "tool",
      name: "read",
      phase: "start",
      status: "running",
    });
    await publisher.onItemEvent({
      itemId: "command:call-1",
      toolCallId: "call-1",
      kind: "tool",
      name: "read",
      phase: "end",
      status: "completed",
      summary: "Read package.json",
      progressText: "package contents",
    });
    await publisher.onItemEvent({
      itemId: "commentary-2",
      kind: "reasoning",
      progressText: "After the tool.",
    });
    await publisher.finalize("completed");

    expect(appends.map((entry) => entry.envelope.type)).toEqual([
      "turn.started",
      "item.completed",
      "item.completed",
      "item.completed",
      "turn.finalized",
    ]);
    expect(appends.map((entry) => entry.envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "commentary-1",
      "call-1",
      "commentary-2",
      "octogee:turn-finalized",
    ]);
    expect(appends.map((entry) => entry.envelope.ref.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(appends[1]?.envelope).toMatchObject({
      eventKey: expectedEventKey("commentary-1"),
      item: {
        kind: "commentary",
        status: "completed",
        summary: "First thought. More detail.",
      },
    });
    expect(appends[2]?.envelope).toMatchObject({
      ref: { itemId: "call-1" },
      item: {
        kind: "tool",
        status: "completed",
        summary: "Read package.json",
      },
    });
    expect(appends.at(-1)?.envelope).toMatchObject({
      eventKey: expectedEventKey("octogee:turn-finalized"),
      outcome: "completed",
    });
  });

  it("redacts before persistence and moves large detail to multipart", async () => {
    const { appends, sink } = createSink();
    const publisher = createAgentActivityPublisher({
      ref: baseRef,
      sink,
      inlineDetailLimitBytes: 24,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });

    await publisher.start();
    await publisher.onItemEvent({
      itemId: "tool:secret",
      toolCallId: "secret",
      kind: "tool",
      phase: "end",
      status: "failed",
      summary: "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      progressText: "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456\nlong output",
    });
    await publisher.finalize("failed");

    const completed = appends.find((entry) => entry.envelope.type === "item.completed");
    expect(JSON.stringify(completed)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(completed?.attachmentBody).toContain("***");
    expect(completed?.envelope).toMatchObject({
      redaction: { policy: "octogee-v1", appliedAt: "producer" },
      item: {
        status: "failed",
        attachment: {
          multipartField: "detail",
          mediaType: "text/markdown",
        },
      },
    });
  });

  it("is idempotent when start and finalize replay", async () => {
    const { appends, sink } = createSink();
    const publisher = createAgentActivityPublisher({ ref: baseRef, sink });

    await publisher.start();
    await publisher.start();
    await publisher.finalize("stopped");
    await publisher.finalize("stopped");

    expect(appends.map((entry) => entry.envelope.type)).toEqual(["turn.started", "turn.finalized"]);
  });
});
