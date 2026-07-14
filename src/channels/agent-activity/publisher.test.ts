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
  const sink = {
    append: vi.fn(async (item) => {
      appends.push(item);
      return {
        postIds: item.envelope.type === "turn.started" ? ["activity-root"] : [],
        activityChannelId: "activity-channel",
      };
    }),
  } satisfies AgentActivitySink;
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

  it("rejects detail larger than the configured Mattermost upload limit", async () => {
    const { sink } = createSink();
    const publisher = createAgentActivityPublisher({
      ref: baseRef,
      sink,
      inlineDetailLimitBytes: 1,
      maxAttachmentBytes: 4,
    });

    await expect(
      publisher.onItemEvent({
        itemId: "tool:large",
        kind: "tool",
        status: "completed",
        progressText: "12345",
      }),
    ).rejects.toThrow("activity detail exceeds 4 bytes");
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

  it("shares one authoritative binding across concurrent starts", async () => {
    let acknowledge:
      | ((value: { postIds: string[]; activityChannelId: string }) => void)
      | undefined;
    const sink = {
      append: vi.fn(
        async () =>
          await new Promise<{ postIds: string[]; activityChannelId: string }>((resolve) => {
            acknowledge = resolve;
          }),
      ),
    } satisfies AgentActivitySink;
    const publisher = createAgentActivityPublisher({ ref: baseRef, sink });

    const first = publisher.start();
    const second = publisher.start();
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    acknowledge?.({ postIds: ["activity-root"], activityChannelId: "activity-channel" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { activityChannelId: "activity-channel", activityRootPostId: "activity-root" },
      { activityChannelId: "activity-channel", activityRootPostId: "activity-root" },
    ]);
    expect(sink.append).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an invalid start binding or a later channel disagreement", async () => {
    const missingRoot = createAgentActivityPublisher({
      ref: baseRef,
      sink: {
        append: vi.fn(async () => ({ postIds: [], activityChannelId: "activity-channel" })),
      },
    });
    await expect(missingRoot.start()).rejects.toThrow(
      "activity turn start requires one root post and an authoritative channel",
    );

    const sink = {
      append: vi
        .fn()
        .mockResolvedValueOnce({
          postIds: ["activity-root"],
          activityChannelId: "activity-channel",
        })
        .mockResolvedValueOnce({ postIds: ["item-1"], activityChannelId: "different-channel" }),
    } satisfies AgentActivitySink;
    const changed = createAgentActivityPublisher({ ref: baseRef, sink });
    await expect(changed.start()).resolves.toEqual({
      activityChannelId: "activity-channel",
      activityRootPostId: "activity-root",
    });
    await expect(
      changed.onItemEvent({
        itemId: "tool-1",
        kind: "tool",
        status: "completed",
        summary: "done",
      }),
    ).rejects.toThrow("changed the authoritative activity channel");
  });

  it.each([
    ["plan", "plan-1"],
    ["patch", "patch-1"],
    ["checkpoint", "checkpoint-1"],
    ["compaction", "compaction-1"],
    ["fallback", "fallback-1"],
  ] as const)(
    "appends changed %s values with monotonic semantic versions",
    async (kind, itemId) => {
      const { appends, sink } = createSink();
      const publisher = createAgentActivityPublisher({ ref: baseRef, sink });

      await publisher.onItemEvent({ itemId, kind, status: "completed", summary: "first" });
      await publisher.onItemEvent({ itemId, kind, status: "completed", summary: "first" });
      await publisher.onItemEvent({ itemId, kind, status: "completed", summary: "second value" });
      await publisher.finalize("completed");

      const items = appends.filter((entry) => entry.envelope.type === "item.completed");
      expect(items).toHaveLength(2);
      expect(items.map((entry) => entry.envelope.ref)).toEqual([
        expect.objectContaining({ itemId, semanticVersion: 1, ordinal: 1 }),
        expect.objectContaining({ itemId, semanticVersion: 2, ordinal: 2 }),
      ]);
    },
  );

  it("uses reserved approval and terminal-error identities and records one control transition", async () => {
    const { appends, sink } = createSink();
    const publisher = createAgentActivityPublisher({ ref: baseRef, sink });

    await publisher.onItemEvent({
      itemId: "provider-approval",
      approvalId: "approval-1",
      kind: "approval",
      status: "waiting",
      summary: "Run deployment?",
    });
    await publisher.transitionApproval({
      approvalId: "approval-1",
      to: "approved",
      actorId: "mm-user-1",
    });
    await publisher.transitionApproval({
      approvalId: "approval-1",
      to: "approved",
      actorId: "mm-user-1",
    });
    await publisher.onItemEvent({
      itemId: "provider-error-a",
      kind: "error",
      status: "failed",
      summary: "terminal failure",
    });
    await publisher.onItemEvent({
      itemId: "provider-error-b",
      kind: "error",
      status: "failed",
      summary: "duplicate failure detail",
    });
    await publisher.finalize("failed");

    expect(appends.map((entry) => entry.envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "octogee:approval:approval-1",
      "octogee:approval:approval-1",
      "octogee:terminal-error",
      "octogee:turn-finalized",
    ]);
    expect(appends[2]?.envelope).toMatchObject({
      type: "control.transition",
      ref: { semanticVersion: 2 },
      control: { from: "waiting", to: "approved", actorId: "mm-user-1" },
    });
  });

  it("protects protocol ids and never journals final-answer or lifecycle lanes", async () => {
    const { appends, sink } = createSink();
    const publisher = createAgentActivityPublisher({ ref: baseRef, sink });

    await publisher.onItemEvent({
      itemId: "octogee:run-root",
      kind: "tool",
      status: "completed",
      progressText: "ordinary provider item",
    });
    await publisher.onItemEvent({
      itemId: "reason-1",
      kind: "reasoning",
      progressText: "released reasoning summary",
    });
    await publisher.onItemEvent({
      itemId: "final-1",
      kind: "final",
      status: "completed",
      progressText: "this is the final assistant answer",
    });
    await publisher.onItemEvent({
      itemId: "life-1",
      kind: "lifecycle",
      progressText: "private runtime plumbing",
    });
    await publisher.finalize("completed");

    expect(appends.map((entry) => entry.envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "source:octogee:run-root",
      "reason-1",
      "octogee:turn-finalized",
    ]);
    expect(JSON.stringify(appends)).not.toContain("final assistant answer");
    expect(JSON.stringify(appends)).not.toContain("private runtime plumbing");
    expect(appends[2]?.envelope).toMatchObject({
      item: { kind: "commentary", detail: { text: "**Thinking**\n\nreleased reasoning summary" } },
    });
  });
});
