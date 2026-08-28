import { describe, expect, it, vi } from "vitest";
import { createAgentActivityRuntime, type AgentActivityTerminalRun } from "./activity-runtime.js";

function start(runtime: ReturnType<typeof createAgentActivityRuntime>, runId = "run-1") {
  return runtime.startRun({
    agentId: "agent-1",
    sessionKey: "agent:agent-1:mattermost:channel-1",
    conversationId: "channel-1",
    turnId: "root-1",
    runId,
    origin: "human",
    mainChannelId: "channel-1",
    mainRootPostId: "root-1",
    inputPostId: "input-1",
    startedAt: 10,
    status: "running",
    live: { phase: "starting", elapsedMs: 0 },
  });
}

describe("agent activity runtime", () => {
  it("constructs Activity aliases from the primary conversation root", async () => {
    const runtime = createAgentActivityRuntime({ now: () => 100 });

    expect(start(runtime)).toMatchObject({
      conversationId: "channel-1",
      turnId: "root-1",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
      activityChannelId: "channel-1",
      activityRootPostId: "root-1",
      revision: 1,
    });
    expect(await runtime.snapshot()).toMatchObject({
      schemaVersion: 1,
      generatedAt: 100,
      runs: [
        {
          runId: "run-1",
          activityChannelId: "channel-1",
          activityRootPostId: "root-1",
        },
      ],
    });
  });

  it("rejects a run whose conversation and primary root diverge", () => {
    const runtime = createAgentActivityRuntime();

    expect(() =>
      runtime.startRun({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:mattermost:channel-1",
        conversationId: "channel-1",
        turnId: "root-1",
        runId: "run-divergent",
        origin: "human",
        mainChannelId: "other-channel",
        mainRootPostId: "root-1",
        startedAt: 10,
        status: "running",
        live: { phase: "starting", elapsedMs: 0 },
      }),
    ).toThrow("must use its main conversation root");
  });

  it("persists and resolves a terminal same-channel run", async () => {
    const writeTerminal = vi.fn(async (_run: AgentActivityTerminalRun) => {});
    const runtime = createAgentActivityRuntime({ now: () => 100, writeTerminal });
    start(runtime);
    expect(runtime.bindRunPrimaryPost("run-1", "answer-1")).toEqual({ outcome: "bound" });
    runtime.updateRun("run-1", {
      status: "waiting",
      live: { phase: "approval", elapsedMs: 25, activeItemId: "approval-1" },
    });

    const terminal = await runtime.finishRun("run-1", "completed");

    expect(terminal).toMatchObject({
      runId: "run-1",
      primaryPostId: "answer-1",
      activityChannelId: "channel-1",
      activityRootPostId: "root-1",
      outcome: "completed",
      finishedAt: 100,
    });
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith(terminal);
    await expect(runtime.resolveRun("run-1")).resolves.toEqual(terminal);
  });

  it("keeps primary answer receipts uniquely owned", () => {
    const runtime = createAgentActivityRuntime();
    start(runtime, "run-1");
    start(runtime, "run-2");

    expect(runtime.bindRunPrimaryPost("run-1", "answer-1")).toEqual({ outcome: "bound" });
    expect(runtime.bindRunPrimaryPost("run-1", "answer-1")).toEqual({
      outcome: "already-bound",
    });
    expect(runtime.bindRunPrimaryPost("run-2", "answer-1")).toEqual({
      outcome: "binding-mismatch",
      ownerRunId: "run-1",
    });
    expect(runtime.clearRunPrimaryPost("run-1", "answer-1")).toEqual({ outcome: "cleared" });
    expect(runtime.bindRunPrimaryPost("run-2", "answer-1")).toEqual({ outcome: "bound" });
  });

  it("reuses durable terminal state after restart", async () => {
    const durable: AgentActivityTerminalRun = {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:mattermost:channel-1",
      conversationId: "channel-1",
      turnId: "root-1",
      runId: "run-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
      inputPostId: "input-1",
      activityChannelId: "channel-1",
      activityRootPostId: "root-1",
      startedAt: 10,
      primaryPostId: "answer-1",
      outcome: "completed",
      finishedAt: 100,
      revision: 2,
    };
    const runtime = createAgentActivityRuntime({ readTerminal: async () => durable });

    await expect(runtime.resolveRun("run-1")).resolves.toEqual(durable);
    await expect(runtime.finishRun("run-1", "failed")).resolves.toEqual(durable);
  });
});
