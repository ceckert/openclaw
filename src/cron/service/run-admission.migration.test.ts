import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { executeCronMigrationInDatabase } from "../store/migration.kernel.js";
import { registerPendingCronSessionCleanup } from "./locked.js";
import { migrateCronAgents } from "./migration.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-admission-migration-" });

it("preserves a held tenant's due occurrence while reserving another tenant", async () => {
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const held = {
    ...createDueIsolatedJob({ id: "held", nowMs: now, nextRunAtMs: now }),
    agentId: "alpha",
  };
  const available = {
    ...createDueIsolatedJob({ id: "available", nowMs: now, nextRunAtMs: now }),
    agentId: "beta",
  };
  await saveCronStore(storePath, { version: 1, jobs: [held, available] });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);
  runOpenClawStateWriteTransaction(({ db }) =>
    executeCronMigrationInDatabase(db, cronStoreKey(storePath), {
      phase: "hold",
      operationId: "move",
      agentIds: ["alpha"],
    }),
  );
  const reservations = await persistQueuedCronRunReservations({
    state,
    candidates: [held, available],
    maxReservations: 1,
    reservedAtMs: now,
  });
  expect(reservations.map((r) => r.job.id)).toEqual(["available"]);
  expect((await loadCronStore(storePath)).jobs.find((j) => j.id === "held")).toEqual(held);
  for (const reserved of reservations) {
    const identity = reserveQueuedCronRun(state, reserved.job.id, now, {
      runReceipt: reserved.runReceipt,
    });
    await cleanupQueuedCronRunReservations({
      state,
      reservations: [{ jobId: reserved.job.id, reservationIdentity: identity }],
    });
  }
  stop(state);
});

it("keeps overdue held occurrences unchanged during scheduler maintenance", async () => {
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const held = {
    ...createDueIsolatedJob({ id: "held", nowMs: now, nextRunAtMs: now - 60000 }),
    agentId: "alpha",
  };
  await saveCronStore(storePath, { version: 1, jobs: [held] });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);
  runOpenClawStateWriteTransaction(({ db }) =>
    executeCronMigrationInDatabase(db, cronStoreKey(storePath), {
      phase: "hold",
      operationId: "move",
      agentIds: ["alpha"],
    }),
  );
  await recomputeUnownedCronSchedules(state, { nowMs: now, recomputeExpired: true });
  expect((await loadCronStore(storePath)).jobs[0]).toEqual(held);
  stop(state);
});

it("allows already reserved work to drain but refuses export until settlement", async () => {
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const job = {
    ...createDueIsolatedJob({ id: "held", nowMs: now, nextRunAtMs: now }),
    agentId: "alpha",
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await list(state);
  const [reserved] = await persistQueuedCronRunReservations({
    state,
    candidates: [job],
    reservedAtMs: now,
  });
  if (!reserved) {
    throw new Error("Expected a durable reservation before migration hold");
  }
  const identity = reserveQueuedCronRun(state, job.id, now, { runReceipt: reserved.runReceipt });
  const migrate = (phase: "hold" | "export") =>
    runOpenClawStateWriteTransaction(({ db }) =>
      executeCronMigrationInDatabase(db, cronStoreKey(storePath), {
        phase,
        operationId: "move",
        agentIds: ["alpha"],
      }),
    );
  migrate("hold");
  expect(migrate("export")).toMatchObject({ drained: false });
  expect(
    await activateQueuedCronRun({ state, job: reserved.job, reservationIdentity: identity }),
  ).toMatchObject({ kind: "activated" });
  await cleanupQueuedCronRunReservations({
    state,
    reservations: [{ jobId: job.id, reservationIdentity: identity }],
  });
  expect(migrate("export")).toMatchObject({ drained: true });
  stop(state);
});

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
