import { describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  type AgentEventRuntimePayload,
  onAgentRuntimeEvent,
} from "../../infra/agent-events.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("isolated cron invocation identity", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("preserves shared run identity while exposing distinct invocation observations", async () => {
    const persistentSessionId = "cron-session-id";
    const lifecycleRevisions = ["cron-revision-1", "cron-revision-2"];
    for (const lifecycleRevision of lifecycleRevisions) {
      resolveCronSessionMock.mockReturnValueOnce(
        makeCronSession({
          lifecycleRevision,
          sessionEntry: makeCronSessionEntry({
            sessionId: persistentSessionId,
            lifecycleRevision,
          }),
        }),
      );
    }
    mockRunCronFallbackPassthrough();
    const observed: AgentEventRuntimePayload[] = [];
    const stop = onAgentRuntimeEvent((event) => {
      if (event.data.identityProbe === true) {
        observed.push(event);
      }
    });
    runEmbeddedAgentMock.mockImplementation(async (request: { runId: string }) => {
      emitAgentEvent({
        runId: request.runId,
        stream: "assistant",
        data: { identityProbe: true },
      });
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    const makeParams = (jobId: string) =>
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ id: jobId, delivery: { mode: "none" } }),
        sessionKey: `cron:${jobId}`,
      });
    await Promise.all([
      runCronIsolatedAgentTurn(makeParams("test-job-1")),
      runCronIsolatedAgentTurn(makeParams("test-job-2")),
    ]);
    stop();

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
    expect(requests.map((request) => request.runId)).toEqual([
      persistentSessionId,
      persistentSessionId,
    ]);
    expect(observed.map((event) => event.runId)).toEqual([
      persistentSessionId,
      persistentSessionId,
    ]);
    expect(observed.map((event) => event.runObservation)).toEqual(
      lifecycleRevisions.map((invocationId) => ({
        origin: "scheduled",
        scheduled: {
          invocationId,
          delivery: { kind: "none" },
        },
      })),
    );
  });
});
