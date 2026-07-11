import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMattermostActivityGatewayRuntime,
  registerMattermostActivityRuntime,
  resetMattermostActivityRuntimesForTests,
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
    } as unknown as AgentActivityRuntime,
  };
}

describe("Mattermost activity gateway runtime", () => {
  afterEach(() => {
    resetMattermostActivityRuntimesForTests();
  });

  it("routes status across accounts and merges snapshots in stable run order", async () => {
    const unregisterLater = registerMattermostActivityRuntime(
      "later",
      registration({ inputPostId: "post-later", runId: "run-later", startedAt: 20 }),
    );
    registerMattermostActivityRuntime(
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

    unregisterLater();
    await expect(runtime.status("post-later")).resolves.toBeNull();
  });
});
