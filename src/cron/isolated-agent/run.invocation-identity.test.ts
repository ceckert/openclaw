import { describe, expect, it } from "vitest";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { makeIsolatedAgentJobFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  registerAgentRunContextMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const { executeCronRun } = await import("./run-executor.js");

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

describe("isolated cron invocation identity", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("uses a fresh event run id for sequential invocations of one persistent session", async () => {
    const persistentSessionId = "cron-session-id";
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({ sessionId: persistentSessionId }),
    });
    mockRunCronFallbackPassthrough();
    const params = {
      cfg: {},
      cfgWithAgentDefaults: {},
      job: makeIsolatedAgentJobFixture(),
      agentId: "default",
      agentDir: "/tmp/agent-dir",
      agentSessionKey: "agent:default:cron:daily",
      runSessionKey: "agent:default:cron:daily:run:cron-session-id",
      workspaceDir: "/tmp/workspace",
      resolvedDelivery: {},
      resolvedDeliveryOk: false,
      deliveryMode: "none" as const,
      deliveryRequested: false,
      sourceDelivery: createSourceDeliveryPlan({ owner: "none", reason: "cron_none" }),
      skillsSnapshot: emptySkillsSnapshot,
      agentPayload: null,
      useSubagentFallbacks: false,
      agentVerboseDefault: undefined,
      liveSelection: { provider: "openai", model: "gpt-5.4" },
      cronSession,
      commandBody: "run a task",
      persistSessionEntry: async () => undefined,
      abortReason: () => "aborted",
      isAborted: () => false,
      immutableThinkLevel: undefined,
      loadThinkingCatalog: async () => [],
      timeoutMs: 60_000,
      suppressExecNotifyOnExit: true,
    };

    await executeCronRun({ ...params, invocationRunId: "cron-invocation-1" });
    await executeCronRun({ ...params, invocationRunId: "cron-invocation-2" });

    const requests = runEmbeddedAgentMock.mock.calls.map(
      (call) =>
        call[0] as {
          runId?: string;
          sessionId?: string;
        },
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.sessionId)).toEqual([
      persistentSessionId,
      persistentSessionId,
    ]);
    const runIds = requests.map((request) => request.runId);
    expect(runIds).toEqual(["cron-invocation-1", "cron-invocation-2"]);
    expect(new Set(runIds).size).toBe(2);
    expect(runIds).not.toContain(persistentSessionId);
    const observations = registerAgentRunContextMock.mock.calls.map((call) => call[1]?.observation);
    expect(observations).toEqual(
      runIds.map((runId) => ({
        origin: "scheduled",
        scheduled: {
          invocationId: runId,
          delivery: { kind: "none" },
        },
      })),
    );
  });
});
