// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { runSkillWorkshopReview } from "../skills/workshop/review-run.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import type { PreparedModelRuntimeLease } from "./prepared-model-runtime.types.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());
vi.mock("./embedded-agent.js", () => ({ runEmbeddedAgent }));

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;
let observedLease: PreparedModelRuntimeLease | undefined;
let acquireReview: (params: RunEmbeddedAgentParams) => Promise<{ meta: { durationMs: number } }>;

const config: OpenClawConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };

function reviewParams(cfg = config): Parameters<typeof runSkillWorkshopReview>[0] {
  return {
    agentId: "default",
    agentDir: state.agentDir("default"),
    workspaceDir: "/tmp/unused-workspace",
    config: cfg,
    provider: "openai",
    model: "review-model",
    prompt: "Review the completed turn.",
    runId: "skill-workshop-review:fixture",
    sessionId: "internal-review",
    sessionKey: "agent:default:internal:review",
    timeoutMs: 1_000,
  };
}

describe("Skill Workshop prepared runtime admission", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "skill-review-runtime" });
    await resetPreparedModelRuntimeHarness(state);
    resetGatewayWorkAdmission();
    observedLease = undefined;
    mocks.configuredAgentIds = ["default"];
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      if (params.reusableRegistry) {
        return params.reusableRegistry;
      }
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(createPluginRecord({ id: "openai" }));
      return registry;
    });
    acquireReview = async (params: RunEmbeddedAgentParams) => {
      const generation = getPreparedModelRuntimePluginGeneration();
      await using lease = await acquireAgentRunPreparedModelRuntime(
        {
          agentId: params.agentId,
          agentDir: params.agentDir!,
          config: params.config!,
          workspaceDir: params.workspaceDir,
          runtimePluginSelections: [
            {
              provider: params.provider!,
              modelId: params.model!,
              runtime: params.agentHarnessRuntimeOverride!,
            },
          ],
        },
        { catalogMode: "static", ...(generation ? { pluginGeneration: generation } : {}) },
      );
      observedLease = lease;
      return { meta: { durationMs: 1 } };
    };
    runEmbeddedAgent.mockReset().mockImplementation(acquireReview);
  });

  afterEach(async (context) => {
    await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
    resetGatewayWorkAdmission();
  });

  it("reuses the current published plugin registry for a detached review's locked model", async () => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    await runSkillWorkshopReview(reviewParams());
    expect(observedLease?.pluginGeneration).toBe(published.pluginGeneration);
    expect(observedLease?.snapshot.pluginRegistry).toBe(published.pluginGeneration.pluginRegistry);
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "review-model",
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
        agentHarnessRuntimeOverride: "openclaw",
      }),
    );
    expect(mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.at(-1)?.[0].reusableRegistry).toBe(
      published.pluginGeneration.pluginRegistry,
    );
  });

  it("waits for replacement and selects its current config and registry outside the old foreground generation", async () => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const previous = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const nextConfig = { ...config, messages: { responsePrefix: "replacement" } };
    const pending = createDeferred<{ entries: [] }>();
    mocks.prepareStaticCatalog.mockImplementationOnce(() => pending.promise);
    const refresh = refreshPreparedModelRuntimeSnapshots(nextConfig, { catalogMode: "static" });
    await vi.waitFor(() => expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2));
    const review = withPreparedModelRuntimePluginGenerationScope(previous.pluginGeneration, () =>
      runSkillWorkshopReview(reviewParams()),
    );
    try {
      await Promise.resolve();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      pending.resolve({ entries: [] });
      await refresh;
      await review;
      const current = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
      expect(observedLease?.pluginGeneration).toBe(current.pluginGeneration);
      expect(observedLease?.pluginGeneration).not.toBe(previous.pluginGeneration);
      expect(observedLease?.snapshot.config).toBe(nextConfig);
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ config: nextConfig, model: "review-model" }),
      );
    } finally {
      pending.resolve({ entries: [] });
      await Promise.allSettled([refresh, review]);
    }
  });

  it("rejects a generation retired between publication selection and run admission", async () => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    runEmbeddedAgent.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      await refreshPreparedModelRuntimeSnapshots(
        { ...config, messages: { responsePrefix: "replacement" } },
        { catalogMode: "static" },
      );
      return acquireReview(params);
    });
    await expect(runSkillWorkshopReview(reviewParams())).rejects.toThrow(
      "plugin generation was superseded",
    );
    expect(observedLease).toBeUndefined();
  });

  it("keeps an uncovered provider selection in its own derived registry", async () => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
    const selected = createEmptyPluginRegistry();
    selected.plugins.push(createPluginRecord({ id: "selected-provider" }));
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
      expect(params.selections).toEqual([
        { provider: "selected", modelId: "review-model", runtime: "openclaw" },
      ]);
      expect(params.reusableRegistry).toBe(published.pluginGeneration.pluginRegistry);
      return selected;
    });
    await runSkillWorkshopReview({ ...reviewParams(), provider: "selected" });
    expect(observedLease?.snapshot.pluginRegistry).toBe(selected);
    expect(observedLease?.pluginGeneration).not.toBe(published.pluginGeneration);
    expect(observedLease?.pluginGeneration.inboundPluginRegistry).toBe(
      published.inboundPluginRegistry,
    );
    expect(published.pluginGeneration.pluginRegistry?.plugins.map(({ id }) => id)).toEqual([
      "openai",
    ]);
  });

  it("cancels a review waiting for replacement without starting the embedded run", async () => {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const pending = createDeferred<{ entries: [] }>();
    mocks.prepareStaticCatalog.mockImplementationOnce(() => pending.promise);
    const refresh = refreshPreparedModelRuntimeSnapshots(
      { ...config, messages: { responsePrefix: "replacement" } },
      { catalogMode: "static" },
    );
    await vi.waitFor(() => expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2));
    const abort = new AbortController();
    const review = runSkillWorkshopReview({ ...reviewParams(), abortSignal: abort.signal });
    try {
      abort.abort();
      await expect(review).rejects.toThrow("aborted");
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      pending.resolve({ entries: [] });
      await Promise.allSettled([refresh, review]);
    }
  });
});
