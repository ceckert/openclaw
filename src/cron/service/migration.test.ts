import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  markCronJobActive,
} from "../active-jobs.js";
import { saveCronStore } from "../store.js";
import { registerPendingCronSessionCleanup } from "./locked.js";
import { migrateCronAgents } from "./migration.js";
import { stop } from "./ops-lifecycle.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-service-migration-" });

it("reports hold drained only after local active work and session cleanup settle", async () => {
  const { storePath } = fixtures.makeStorePath();
  const state = createCronRegressionState({
    storePath,
    nowMs: () => Date.now(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  state.deps.cronEnabled = false;
  const marker = markCronJobActive("ongoing", { agentId: "alpha" });
  const request = { operationId: "drain", phase: "hold" as const, agentIds: ["alpha"] };
  let release: (() => void) | undefined;
  try {
    expect(await migrateCronAgents(state, request)).toMatchObject({ drained: false });
    advanceCronActiveJobGeneration();
    expect(await migrateCronAgents(state, request)).toMatchObject({ drained: false });
    clearCronJobActive("ongoing", marker);
    release = registerPendingCronSessionCleanup(state, "ongoing", Promise.resolve(), "alpha");
    expect(await migrateCronAgents(state, request)).toMatchObject({ drained: false });
    release();
    expect(await migrateCronAgents(state, request)).toMatchObject({ drained: true });
  } finally {
    clearCronJobActive("ongoing", marker);
    release?.();
    stop(state);
  }
});

it("holds a tenant beside legacy jobs owned by the configured default agent", async () => {
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const tenant = {
    ...createDueIsolatedJob({ id: "tenant", nowMs: now, nextRunAtMs: now + 60_000 }),
    agentId: "alpha",
  };
  const { agentId: _unowned, ...legacy } = createDueIsolatedJob({
    id: "legacy",
    nowMs: now,
    nextRunAtMs: now + 60_000,
  });
  await saveCronStore(storePath, { version: 1, jobs: [tenant, legacy] });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    resolveDefaultAgentId: () => "main",
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await expect(
    migrateCronAgents(state, { operationId: "move", phase: "hold", agentIds: ["alpha"] }),
  ).resolves.toMatchObject({ agentIds: ["alpha"], drained: true });
  const exported = await migrateCronAgents(state, { operationId: "move", phase: "export" });
  expect(exported.snapshot?.jobs.map((job) => job.id)).toEqual(["tenant"]);
  stop(state);
});
