import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import type { CronStoredJob } from "../types.js";
import {
  assertCronAgentMigrationAdmitted,
  executeCronMigrationInDatabase,
} from "./migration.kernel.js";
import { loadCronRows, loadedCronStoreFromRows, upsertCronJobRow } from "./row-codec.js";

const databases: DatabaseSync[] = [];
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});
function job(id = "job-a", agentId = "alpha"): CronStoredJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    createdAtMs: 10,
    updatedAtMs: 20,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the weather" },
    state: { nextRunAtMs: 60123, lastRunAtMs: 123, lastRunStatus: "ok" },
  };
}
function migrate(
  db: DatabaseSync,
  phase: Parameters<typeof executeCronMigrationInDatabase>[2]["phase"],
  extra = {},
) {
  return executeCronMigrationInDatabase(db, "store", { operationId: "move-a", phase, ...extra });
}

describe("tenant scheduler migration", () => {
  it("moves exact jobs and due state while both sides remain fenced until activation", () => {
    const source = database(),
      target = database();
    upsertCronJobRow(source, "store", job(), 0);
    upsertCronJobRow(source, "store", job("other", "beta"), 1);
    migrate(source, "hold", { agentIds: ["alpha"] });
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).toThrow(/migration/);
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "beta")).not.toThrow();
    const snapshot = migrate(source, "export").snapshot;
    migrate(target, "stage", { agentIds: ["alpha"], snapshot });
    expect(() => assertCronAgentMigrationAdmitted(target, "store", "alpha")).toThrow(/migration/);
    expect(loadedCronStoreFromRows(loadCronRows(target, "store")).store.jobs).toEqual(
      snapshot?.jobs,
    );
    migrate(target, "activate");
    expect(() => assertCronAgentMigrationAdmitted(target, "store", "alpha")).not.toThrow();
    migrate(source, "retire");
    expect(
      loadedCronStoreFromRows(loadCronRows(source, "store")).store.jobs.map((j) => j.id),
    ).toEqual(["other"]);
    expect(() => migrate(source, "resume")).toThrow(/retired/);
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).toThrow(/migration/);
  });
  it("returns to a retired gateway with a new operation while rejecting stale unfencing commands", () => {
    const a = database(),
      b = database();
    upsertCronJobRow(a, "store", job(), 0);
    const step = (
      db: DatabaseSync,
      operationId: string,
      phase: Parameters<typeof executeCronMigrationInDatabase>[2]["phase"],
      extra = {},
    ) => executeCronMigrationInDatabase(db, "store", { operationId, phase, ...extra });
    step(a, "outbound", "hold", { agentIds: ["alpha"] });
    const outbound = step(a, "outbound", "export").snapshot;
    step(b, "outbound", "stage", { agentIds: ["alpha"], snapshot: outbound });
    step(a, "outbound", "retire");
    step(b, "outbound", "activate");
    step(b, "return", "hold", { agentIds: ["alpha"] });
    const incoming = step(b, "return", "export").snapshot;
    step(a, "return", "hold", { agentIds: ["alpha"] });
    step(a, "return", "stage", { agentIds: ["alpha"], snapshot: incoming });
    expect(() => step(a, "outbound", "resume")).toThrow(/retired/);
    expect(() => step(a, "outbound", "abort")).toThrow(/retired/);
    expect(() => assertCronAgentMigrationAdmitted(a, "store", "alpha")).toThrow(/return/);
    step(b, "return", "retire");
    step(a, "return", "activate");
    expect(loadedCronStoreFromRows(loadCronRows(a, "store")).store.jobs).toEqual(incoming?.jobs);
    expect(loadCronRows(b, "store")).toHaveLength(0);
  });

  it("records early rollback so delayed hold and stage cannot revive an operation", () => {
    const source = database(),
      target = database();
    migrate(source, "resume");
    migrate(target, "abort");
    expect(() => migrate(source, "hold", { agentIds: ["alpha"] })).toThrow(/resumed/);
    expect(() =>
      migrate(target, "stage", {
        agentIds: ["alpha"],
        snapshot: {
          version: 1,
          operationId: "move-a",
          agentIds: ["alpha"],
          jobs: [job()],
          scratch: [],
        },
      }),
    ).toThrow(/aborted/);
    expect(migrate(source, "resume")).toMatchObject({ drained: true, agentIds: [] });
    expect(migrate(target, "abort")).toMatchObject({ drained: true, agentIds: [] });
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).not.toThrow();
    expect(() => assertCronAgentMigrationAdmitted(target, "store", "alpha")).not.toThrow();
    expect(loadCronRows(target, "store")).toHaveLength(0);
  });

  it("aborts only staged jobs then permits source resume", () => {
    const source = database(),
      target = database();
    upsertCronJobRow(source, "store", job(), 0);
    migrate(source, "hold", { agentIds: ["alpha"] });
    const snapshot = migrate(source, "export").snapshot;
    migrate(target, "stage", { agentIds: ["alpha"], snapshot });
    migrate(target, "abort");
    migrate(target, "abort");
    expect(loadCronRows(target, "store")).toHaveLength(0);
    migrate(source, "resume");
    expect(() => migrate(source, "hold", { agentIds: ["alpha"] })).toThrow(/resumed/);
    expect(() => migrate(target, "hold", { agentIds: ["alpha"] })).toThrow(/aborted/);
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).not.toThrow();
  });
  it("refuses export while a receipt is unsettled and does not change enabled flags", () => {
    const db = database();
    upsertCronJobRow(db, "store", job(), 0);
    migrate(db, "hold", { agentIds: ["alpha"] });
    db.prepare("INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "r",
      "store",
      "job-a",
      "rev",
      "alpha",
      null,
      "running",
      1,
      1,
      1,
      null,
      null,
    );
    expect(migrate(db, "export")).toMatchObject({ drained: false });
    expect(
      expectDefined(loadedCronStoreFromRows(loadCronRows(db, "store")).store.jobs[0], "held job")
        .enabled,
    ).toBe(true);
  });
  it("refuses oversized export before transferring ownership", () => {
    const source = database();
    upsertCronJobRow(
      source,
      "store",
      { ...job(), payload: { kind: "agentTurn", message: "x".repeat(8 * 1024 * 1024) } },
      0,
    );
    migrate(source, "hold", { agentIds: ["alpha"] });
    expect(() => migrate(source, "export")).toThrow(/8 MiB/);
    migrate(source, "resume");
    expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).not.toThrow();
    expect(loadCronRows(source, "store")).toHaveLength(1);
  });

  it("rejects target conflicts, wrong tenant scope, and unsafe process schedules", () => {
    const source = database(),
      target = database();
    upsertCronJobRow(source, "store", job(), 0);
    migrate(source, "hold", { agentIds: ["alpha"] });
    const snapshot = migrate(source, "export").snapshot;
    upsertCronJobRow(target, "store", job(), 0);
    expect(() => migrate(target, "stage", { agentIds: ["alpha"], snapshot })).toThrow(/conflict/);
    expect(() => migrate(source, "export", { agentIds: ["beta"] })).toThrow(/scope/);
    const unsafe = database();
    upsertCronJobRow(
      unsafe,
      "store",
      { ...job(), schedule: { kind: "on-exit", command: "true" } },
      0,
    );
    expect(() => migrate(unsafe, "hold", { agentIds: ["alpha"] })).toThrow(/on-exit/);
  });
  it("migrates a tenant beside a legacy job owned by another default agent", () => {
    const source = database();
    const { agentId: _unowned, ...legacy } = job("legacy");
    upsertCronJobRow(source, "store", job(), 0);
    upsertCronJobRow(source, "store", legacy, 1);
    const step = (phase: Parameters<typeof migrate>[1], extra = {}) =>
      executeCronMigrationInDatabase(
        source,
        "store",
        { operationId: "move-a", phase, ...extra },
        "main",
      );
    step("hold", { agentIds: ["alpha"] });
    expect(step("export").snapshot?.jobs.map((j) => j.id)).toEqual(["job-a"]);
    step("retire");
    expect(
      loadedCronStoreFromRows(loadCronRows(source, "store")).store.jobs.map((j) => j.id),
    ).toEqual(["legacy"]);
  });
  it("carries a legacy job with an explicit owner when its default agent moves", () => {
    const source = database(),
      target = database();
    const { agentId: _unowned, ...legacy } = job("legacy");
    upsertCronJobRow(source, "store", legacy, 0);
    executeCronMigrationInDatabase(
      source,
      "store",
      { operationId: "move-main", phase: "hold", agentIds: ["main"] },
      "main",
    );
    const snapshot = executeCronMigrationInDatabase(
      source,
      "store",
      { operationId: "move-main", phase: "export" },
      "main",
    ).snapshot;
    expect(snapshot?.jobs.map((j) => j.agentId)).toEqual(["main"]);
    executeCronMigrationInDatabase(
      target,
      "store",
      { operationId: "move-main", phase: "stage", agentIds: ["main"], snapshot },
      "other",
    );
    expect(
      loadedCronStoreFromRows(loadCronRows(target, "store")).store.jobs.map((j) => j.agentId),
    ).toEqual(["main"]);
  });
  it("refuses legacy jobs when no default agent can own them", () => {
    const source = database();
    const { agentId: _unowned, ...legacy } = job("legacy");
    upsertCronJobRow(source, "store", job(), 0);
    upsertCronJobRow(source, "store", legacy, 1);
    expect(() => migrate(source, "hold", { agentIds: ["alpha"] })).toThrow(/explicit owner/);
  });
});
