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
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      startedAt: 900,
      status: "running",
      live: { phase: "thinking", elapsedMs: 100 },
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
          revision: 2,
          status: "waiting",
          live: { phase: "approval", elapsedMs: 200 },
        }),
      ],
      admissions: [
        {
          inputPostId: "queued-1",
          conversationId: "channel-1",
          status: "queued",
          queuePosition: 1,
          revision: 3,
        },
      ],
    });
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
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      startedAt: 1,
      status: "running",
      live: { phase: "thinking", elapsedMs: 0 },
    });
    now = 20;
    await expect(runtime.finishRun("run-1", "failed")).resolves.toMatchObject({
      runId: "run-1",
      outcome: "failed",
      finishedAt: 20,
      revision: 2,
    });

    expect(runtime.updateRun("run-1", { status: "waiting" })).toBe(false);
    expect(runtime.activeRunForConversation("channel-1")).toBeUndefined();
    const restarted = createRuntime();
    await expect(restarted.resolveRun("run-1")).resolves.toMatchObject({
      runId: "run-1",
      outcome: "failed",
      revision: 2,
    });
    await expect(restarted.finishRun("run-1", "completed")).resolves.toMatchObject({
      outcome: "failed",
      revision: 2,
    });
  });
});
