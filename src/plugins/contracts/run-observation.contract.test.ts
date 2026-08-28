import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  withAgentRunObservationContext,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "../host-hook-runtime.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("plugin run observation contract", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("exposes immutable admitted run lineage to agent event subscribers", () => {
    const { config, registry } = createPluginRegistryFixture();
    const handler = vi.fn();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "run-lineage-plugin", name: "Run Lineage Plugin" }),
      register(api) {
        api.agent.events.registerAgentEventSubscription({
          id: "lineage",
          handle: handler,
        });
      },
    });
    registerAgentRunContext("retry-run", {
      observation: { origin: "retry", retryOfRunId: "parent-run" },
    });

    dispatchPluginAgentEventSubscriptions({
      registry: registry.registry,
      event: { runId: "retry-run", stream: "assistant", data: {} } as never,
      isLive: () => true,
    });

    const context = handler.mock.calls[0]?.[1] as { run?: unknown } | undefined;
    expect(context?.run).toEqual({ origin: "retry", retryOfRunId: "parent-run" });
    expect(Object.isFrozen(context?.run)).toBe(true);
  });

  it("keeps interleaved scheduled observations bound to their own invocation", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const seen: Array<{
      runId: string;
      seq: number;
      run: unknown;
      exposesRuntimeObservation: boolean;
    }> = [];
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "scheduled-run-plugin", name: "Scheduled Run Plugin" }),
      register(api) {
        api.agent.events.registerAgentEventSubscription({
          id: "scheduled",
          handle(event, context) {
            seen.push({
              runId: event.runId,
              seq: event.seq,
              run: context.run,
              exposesRuntimeObservation: "runObservation" in event,
            });
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const sharedRunId = "scheduled-session";
    const firstStarted = createDeferred();
    const continueFirst = createDeferred();
    const firstFinished = createDeferred();
    const first = withAgentRunObservationContext(
      {
        origin: "scheduled",
        scheduled: {
          invocationId: "cron-revision-1",
          delivery: {
            kind: "chat",
            channel: "mattermost",
            to: "channel-1",
            threadId: "thread-1",
          },
        },
      },
      async () => {
        emitAgentEvent({ runId: sharedRunId, stream: "assistant", data: { part: "first-a" } });
        firstStarted.resolve();
        await continueFirst.promise;
        emitAgentEvent({ runId: sharedRunId, stream: "assistant", data: { part: "first-b" } });
        firstFinished.resolve();
      },
    );
    await firstStarted.promise;
    const second = withAgentRunObservationContext(
      {
        origin: "scheduled",
        scheduled: {
          invocationId: "cron-revision-2",
          delivery: { kind: "none" },
        },
      },
      async () => {
        emitAgentEvent({ runId: sharedRunId, stream: "assistant", data: { part: "second-a" } });
        continueFirst.resolve();
        await firstFinished.promise;
        emitAgentEvent({ runId: sharedRunId, stream: "assistant", data: { part: "second-b" } });
      },
    );
    await Promise.all([first, second]);
    await waitForPluginEventHandlers();

    expect(seen.map(({ runId, seq }) => ({ runId, seq }))).toEqual([
      { runId: sharedRunId, seq: 1 },
      { runId: sharedRunId, seq: 2 },
      { runId: sharedRunId, seq: 3 },
      { runId: sharedRunId, seq: 4 },
    ]);
    expect(
      seen.map(
        (entry) =>
          (entry.run as { scheduled?: { invocationId?: string } } | undefined)?.scheduled
            ?.invocationId,
      ),
    ).toEqual(["cron-revision-1", "cron-revision-2", "cron-revision-1", "cron-revision-2"]);
    expect(seen.every((entry) => Object.isFrozen(entry.run))).toBe(true);
    expect(
      seen.every((entry) =>
        Object.isFrozen(
          (entry.run as { scheduled?: { delivery?: unknown } } | undefined)?.scheduled?.delivery,
        ),
      ),
    ).toBe(true);
    expect(seen.every((entry) => !entry.exposesRuntimeObservation)).toBe(true);
  });
});
