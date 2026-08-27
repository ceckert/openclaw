import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMattermostActivityGatewayRuntime,
  registerMattermostActivityRuntime,
} from "./activity-gateway-runtime.js";
import type { AgentActivityRuntime } from "./activity-runtime.js";
import type { MattermostAdmissionService } from "./admission.js";

function registration(params: { inputPostId: string; runId: string; startedAt: number }): {
  admission: MattermostAdmissionService;
  activity: AgentActivityRuntime;
} {
  return {
    admission: {
      status: vi.fn(async (inputPostId: string) =>
        inputPostId === params.inputPostId
          ? {
              inputPostId,
              conversationId: "channel-1",
              turnId: params.inputPostId,
              state: "pending" as const,
              revision: 1,
            }
          : null,
      ),
      snapshotAdmissions: vi.fn(async () => []),
    } as unknown as MattermostAdmissionService,
    activity: {
      snapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        generatedAt: 100,
        runs: [
          {
            agentId: "agent-1",
            sessionKey: "session-1",
            conversationId: "channel-1",
            turnId: params.inputPostId,
            runId: params.runId,
            origin: "human" as const,
            mainChannelId: "channel-1",
            mainRootPostId: params.inputPostId,
            inputPostId: params.inputPostId,
            activityChannelId: "activity-channel-1",
            activityRootPostId: `activity-${params.runId}`,
            startedAt: params.startedAt,
            revision: 1,
            status: "running" as const,
            live: { phase: "working", elapsedMs: 0 },
          },
        ],
        admissions: [],
      })),
      resolveRun: vi.fn(async (runId: string) =>
        runId === params.runId
          ? {
              agentId: "agent-1",
              sessionKey: "session-1",
              conversationId: "channel-1",
              turnId: params.inputPostId,
              runId: params.runId,
              origin: "human" as const,
              mainChannelId: "channel-1",
              mainRootPostId: params.inputPostId,
              inputPostId: params.inputPostId,
              activityChannelId: "activity-channel-1",
              activityRootPostId: `activity-${params.runId}`,
              primaryPostId: `primary-${params.runId}`,
              startedAt: params.startedAt,
              revision: 2,
              status: "running" as const,
              live: { phase: "working", elapsedMs: 0 },
            }
          : undefined,
      ),
    } as unknown as AgentActivityRuntime,
  };
}

const unregisterActivityRuntimes: Array<() => void> = [];

function registerRuntime(accountId: string, runtime: ReturnType<typeof registration>): () => void {
  const unregister = registerMattermostActivityRuntime(accountId, runtime);
  unregisterActivityRuntimes.push(unregister);
  return unregister;
}

describe("Mattermost activity gateway runtime", () => {
  afterEach(() => {
    for (const unregister of unregisterActivityRuntimes.splice(0).toReversed()) {
      unregister();
    }
  });

  it("routes status across accounts and merges snapshots in stable run order", async () => {
    const unregisterLater = registerRuntime(
      "later",
      registration({ inputPostId: "post-later", runId: "run-later", startedAt: 20 }),
    );
    registerRuntime(
      "earlier",
      registration({ inputPostId: "post-earlier", runId: "run-earlier", startedAt: 10 }),
    );
    const runtime = getMattermostActivityGatewayRuntime();

    await expect(runtime.status("post-earlier")).resolves.toMatchObject({
      inputPostId: "post-earlier",
      revision: 1,
    });
    await expect(runtime.snapshot()).resolves.toMatchObject({
      schemaVersion: 1,
      runs: [{ runId: "run-earlier" }, { runId: "run-later" }],
    });
    await expect(runtime.resolveRun("run-earlier")).resolves.toMatchObject({
      outcome: "found",
      run: {
        ref: {
          schemaVersion: 3,
          projectionKind: "run",
          runId: "run-earlier",
          status: "running",
        },
        primaryPostId: "primary-run-earlier",
      },
    });
    await expect(runtime.resolveRun("missing")).resolves.toEqual({
      outcome: "not-found",
      runId: "missing",
    });

    unregisterLater();
    await expect(runtime.status("post-later")).resolves.toBeNull();
  });

  it("returns a typed mismatch instead of choosing between duplicate run identities", async () => {
    registerRuntime(
      "first",
      registration({ inputPostId: "post-1", runId: "run-1", startedAt: 10 }),
    );
    registerRuntime(
      "second",
      registration({ inputPostId: "post-2", runId: "run-1", startedAt: 20 }),
    );

    await expect(getMattermostActivityGatewayRuntime().resolveRun("run-1")).resolves.toEqual({
      outcome: "identity-mismatch",
      runId: "run-1",
    });
  });

  it("projects a durable terminal run with its exact v3 identity and primary receipt", async () => {
    const terminal = registration({ inputPostId: "post-1", runId: "run-1", startedAt: 10 });
    terminal.activity.resolveRun = vi.fn(async () => ({
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "channel-1",
      turnId: "post-1",
      runId: "run-1",
      origin: "human" as const,
      mainChannelId: "channel-1",
      mainRootPostId: "post-1",
      inputPostId: "post-1",
      activityChannelId: "activity-channel-1",
      activityRootPostId: "activity-run-1",
      primaryPostId: "primary-run-1",
      startedAt: 10,
      outcome: "failed" as const,
      finishedAt: 20,
      revision: 4,
    }));
    registerRuntime("terminal", terminal);

    await expect(getMattermostActivityGatewayRuntime().resolveRun("run-1")).resolves.toEqual({
      outcome: "found",
      run: {
        ref: {
          schemaVersion: 3,
          projectionKind: "run",
          conversationId: "channel-1",
          turnId: "post-1",
          runId: "run-1",
          origin: "human",
          status: "failed",
          mainChannelId: "channel-1",
          mainRootPostId: "post-1",
          inputPostId: "post-1",
          activityChannelId: "activity-channel-1",
          activityRootPostId: "activity-run-1",
          attention: "failure",
        },
        agentId: "agent-1",
        sessionKey: "session-1",
        primaryPostId: "primary-run-1",
        startedAt: 10,
        finishedAt: 20,
        revision: 4,
      },
    });
  });
});
