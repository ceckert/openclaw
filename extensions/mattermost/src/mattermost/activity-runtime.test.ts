import { describe, expect, it } from "vitest";
import { createAgentActivityRuntime } from "./activity-runtime.js";

describe("createAgentActivityRuntime", () => {
  it("returns a monotonic snapshot of active runs and durable admissions", async () => {
    let now = 1000;
    const runtime = createAgentActivityRuntime({
      now: () => now,
      readAdmissions: async () => [
        {
          inputPostId: "queued-1",
          conversationId: "channel-1",
          turnId: "queued-1",
          mainChannelId: "channel-1",
          activityChannelId: "activity-channel-1",
          origin: "followup",
          status: "queued",
          queuePosition: 1,
          revision: 3,
        },
      ],
    });
    runtime.startRun({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:mattermost:channel:channel-1",
      conversationId: "channel-1",
      turnId: "post-1",
      runId: "run-1",
      parentRunId: "parent-1",
      retryOfRunId: "failed-1",
      origin: "retry",
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      inputPostId: "retry-marker-1",
      startedAt: 900,
      status: "running",
      live: { phase: "thinking", elapsedMs: 100 },
    });
    expect(
      runtime.bindRunActivity("run-1", {
        activityChannelId: "activity-channel-1",
        activityRootPostId: "activity-root-1",
      }),
    ).toBe(true);
    expect(runtime.bindRunPrimaryPost("run-1", "primary-post-1")).toEqual({
      outcome: "bound",
    });
    now = 1100;
    runtime.updateRun("run-1", {
      status: "waiting",
      live: { phase: "approval", elapsedMs: 200 },
    });

    await expect(runtime.snapshot()).resolves.toEqual({
      schemaVersion: 1,
      generatedAt: 1100,
      runs: [
        expect.objectContaining({
          runId: "run-1",
          parentRunId: "parent-1",
          retryOfRunId: "failed-1",
          origin: "retry",
          inputPostId: "retry-marker-1",
          activityChannelId: "activity-channel-1",
          activityRootPostId: "activity-root-1",
          revision: 4,
          status: "waiting",
          live: { phase: "approval", elapsedMs: 200 },
        }),
      ],
      admissions: [
        {
          inputPostId: "queued-1",
          conversationId: "channel-1",
          turnId: "queued-1",
          mainChannelId: "channel-1",
          activityChannelId: "activity-channel-1",
          origin: "followup",
          status: "queued",
          queuePosition: 1,
          revision: 3,
        },
      ],
    });
  });

  it("does not expose a run until its authoritative Activity acknowledgement is latched", async () => {
    const runtime = createAgentActivityRuntime({ now: () => 100 });
    runtime.startRun({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:mattermost:channel:channel-1",
      conversationId: "channel-1",
      turnId: "turn-1",
      runId: "run-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "turn-1",
      inputPostId: "turn-1",
      startedAt: 90,
      status: "running",
      live: { phase: "starting", elapsedMs: 10 },
    });

    await expect(runtime.snapshot()).resolves.toMatchObject({ runs: [] });
    expect(
      runtime.bindRunActivity("run-1", {
        activityChannelId: "activity-channel-1",
        activityRootPostId: "activity-root-1",
      }),
    ).toBe(true);
    expect(
      runtime.bindRunActivity("run-1", {
        activityChannelId: "activity-channel-1",
        activityRootPostId: "activity-root-1",
      }),
    ).toBe(false);
    await expect(runtime.snapshot()).resolves.toMatchObject({
      runs: [
        {
          runId: "run-1",
          origin: "human",
          mainChannelId: "channel-1",
          mainRootPostId: "turn-1",
          inputPostId: "turn-1",
          activityChannelId: "activity-channel-1",
          activityRootPostId: "activity-root-1",
          revision: 2,
        },
      ],
    });
    expect(() =>
      runtime.bindRunActivity("run-1", {
        activityChannelId: "different-activity-channel",
        activityRootPostId: "activity-root-1",
      }),
    ).toThrow(/binding conflict/);
  });

  it("durably resolves terminal outcomes after restart without stale-update resurrection", async () => {
    let now = 10;
    const durable = new Map();
    const createRuntime = () =>
      createAgentActivityRuntime({
        now: () => now,
        writeTerminal: async (run) => {
          durable.set(run.runId, structuredClone(run));
        },
        readTerminal: async (runId) => durable.get(runId),
      });
    const runtime = createRuntime();
    runtime.startRun({
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "channel-1",
      turnId: "post-1",
      runId: "run-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      inputPostId: "post-1",
      startedAt: 1,
      status: "running",
      live: { phase: "thinking", elapsedMs: 0 },
    });
    runtime.bindRunActivity("run-1", {
      activityChannelId: "activity-channel-1",
      activityRootPostId: "activity-root-1",
    });
    expect(runtime.bindRunPrimaryPost("run-1", "primary-post-1")).toEqual({
      outcome: "bound",
    });
    now = 20;
    await expect(runtime.finishRun("run-1", "failed")).resolves.toMatchObject({
      runId: "run-1",
      outcome: "failed",
      primaryPostId: "primary-post-1",
      finishedAt: 20,
      revision: 4,
    });

    expect(runtime.updateRun("run-1", { status: "waiting" })).toBe(false);
    expect(runtime.activeRunForConversation("channel-1")).toBeUndefined();
    const restarted = createRuntime();
    await expect(restarted.resolveRun("run-1")).resolves.toMatchObject({
      runId: "run-1",
      outcome: "failed",
      primaryPostId: "primary-post-1",
      revision: 4,
    });
    await expect(restarted.finishRun("run-1", "completed")).resolves.toMatchObject({
      outcome: "failed",
      revision: 4,
    });

    restarted.startRun({
      agentId: "agent-1",
      sessionKey: "session-2",
      conversationId: "channel-1",
      turnId: "post-2",
      runId: "run-2",
      origin: "followup",
      mainChannelId: "channel-1",
      mainRootPostId: "post-2",
      inputPostId: "post-2",
      startedAt: 21,
      status: "running",
      live: { phase: "thinking", elapsedMs: 0 },
    });
    restarted.bindRunActivity("run-2", {
      activityChannelId: "activity-channel-1",
      activityRootPostId: "activity-root-2",
    });
    expect(restarted.bindRunPrimaryPost("run-2", "primary-post-1")).toEqual({
      outcome: "binding-mismatch",
      ownerRunId: "run-1",
    });
  });

  it("owns one exact primary response receipt per run and only replaces an explicitly cleared preview", () => {
    const runtime = createAgentActivityRuntime({ now: () => 100 });
    runtime.startRun({
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "channel-1",
      turnId: "turn-1",
      runId: "run-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "turn-1",
      inputPostId: "turn-1",
      startedAt: 90,
      status: "running",
      live: { phase: "thinking", elapsedMs: 10 },
    });

    expect(runtime.bindRunPrimaryPost("missing", "preview-1")).toEqual({
      outcome: "not-found",
    });
    expect(runtime.bindRunPrimaryPost("run-1", "preview-1")).toEqual({ outcome: "bound" });
    expect(runtime.bindRunPrimaryPost("run-1", "preview-1")).toEqual({
      outcome: "already-bound",
    });
    expect(runtime.bindRunPrimaryPost("run-1", "final-1")).toEqual({
      outcome: "binding-mismatch",
      ownerRunId: "run-1",
    });
    expect(runtime.clearRunPrimaryPost("run-1", "another-preview")).toEqual({
      outcome: "binding-mismatch",
      ownerRunId: "run-1",
    });
    expect(runtime.clearRunPrimaryPost("run-1", "preview-1")).toEqual({ outcome: "cleared" });
    expect(runtime.bindRunPrimaryPost("run-1", "final-1")).toEqual({ outcome: "bound" });
  });
});
