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
  describe("partial handoff", () => {
    const hostBound = (id: string): CronStoredJob => ({
      ...job(id),
      schedule: { kind: "on-exit", command: "true" },
    });
    const scratchRow = (db: DatabaseSync, jobId: string) =>
      db
        .prepare(
          "INSERT INTO cron_job_scratch (store_key, job_id, content, revision, source_sha256, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("store", jobId, `notes for ${jobId}`, 1, null, 5);
    const jobIds = (db: DatabaseSync) =>
      loadedCronStoreFromRows(loadCronRows(db, "store"))
        .store.jobs.map((entry) => entry.id)
        .toSorted();

    it("exports portable jobs, reports retained host-bound jobs, and keeps them fenced after retire", () => {
      const source = database();
      upsertCronJobRow(source, "store", job(), 0);
      upsertCronJobRow(source, "store", hostBound("job-x"), 1);
      scratchRow(source, "job-a");
      scratchRow(source, "job-x");
      expect(() => migrate(source, "hold", { agentIds: ["alpha"] })).toThrow(/on-exit/);
      migrate(source, "hold", { agentIds: ["alpha"], retainNonportable: true });
      expect(() => migrate(source, "export")).toThrow(/on-exit/);
      const snapshot = expectDefined(
        migrate(source, "export", { retainNonportable: true }).snapshot,
        "partial snapshot",
      );
      expect(snapshot.jobs.map((entry) => entry.id)).toEqual(["job-a"]);
      expect(snapshot.retainedJobIds).toEqual(["job-x"]);
      expect(snapshot.scratch.map((entry) => entry.jobId)).toEqual(["job-a"]);
      expect(migrate(source, "export", { retainNonportable: true }).snapshot).toEqual(snapshot);
      migrate(source, "retire");
      expect(jobIds(source)).toEqual(["job-x"]);
      expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).toThrow(/migration/);
      expect(
        source
          .prepare("SELECT job_id FROM cron_job_scratch WHERE store_key = ? ORDER BY job_id")
          .all("store"),
      ).toEqual([{ job_id: "job-x" }]);
    });

    it("stages beside retained jobs after retirement and runs both once activated", () => {
      const home = database(),
        away = database();
      upsertCronJobRow(home, "store", job(), 0);
      upsertCronJobRow(home, "store", hostBound("job-x"), 1);
      const step = (
        db: DatabaseSync,
        operationId: string,
        phase: Parameters<typeof executeCronMigrationInDatabase>[2]["phase"],
        extra = {},
      ) => executeCronMigrationInDatabase(db, "store", { operationId, phase, ...extra });
      step(home, "out", "hold", { agentIds: ["alpha"], retainNonportable: true });
      const outbound = step(home, "out", "export", { retainNonportable: true }).snapshot;
      step(away, "out", "stage", { agentIds: ["alpha"], snapshot: outbound });
      step(home, "out", "retire");
      step(away, "out", "activate");
      step(away, "back", "hold", { agentIds: ["alpha"] });
      const incoming = expectDefined(step(away, "back", "export").snapshot, "return snapshot");
      expect(() => step(home, "back", "hold", { agentIds: ["alpha"] })).toThrow(/on-exit/);
      step(home, "back", "hold", { agentIds: ["alpha"], retainNonportable: true });
      expect(() =>
        step(home, "back", "stage", { agentIds: ["alpha"], snapshot: incoming }),
      ).toThrow(/conflict/);
      expect(() =>
        step(home, "back", "stage", {
          agentIds: ["alpha"],
          retainNonportable: true,
          snapshot: { ...incoming, jobs: [...incoming.jobs, job("job-x")] },
        }),
      ).toThrow(/conflict/);
      step(home, "back", "stage", {
        agentIds: ["alpha"],
        retainNonportable: true,
        snapshot: incoming,
      });
      expect(jobIds(home)).toEqual(["job-a", "job-x"]);
      expect(() => assertCronAgentMigrationAdmitted(home, "store", "alpha")).toThrow(/back/);
      step(away, "back", "retire");
      step(home, "back", "activate");
      expect(() => assertCronAgentMigrationAdmitted(home, "store", "alpha")).not.toThrow();
      expect(jobIds(home)).toEqual(["job-a", "job-x"]);
      expect(loadCronRows(away, "store")).toHaveLength(0);
    });

    it("refuses staging beside jobs that no retired migration retained", () => {
      const live = database();
      upsertCronJobRow(live, "store", hostBound("job-x"), 0);
      const incoming = {
        version: 1 as const,
        operationId: "move-a",
        agentIds: ["alpha"],
        jobs: [job("job-b")],
        scratch: [],
      };
      migrate(live, "hold", { agentIds: ["alpha"], retainNonportable: true });
      expect(() =>
        migrate(live, "stage", {
          agentIds: ["alpha"],
          retainNonportable: true,
          snapshot: incoming,
        }),
      ).toThrow(/not retained by a retired migration/);
      expect(jobIds(live)).toEqual(["job-x"]);

      const exporting = database();
      upsertCronJobRow(exporting, "store", job(), 0);
      upsertCronJobRow(exporting, "store", hostBound("job-x"), 1);
      migrate(exporting, "hold", { agentIds: ["alpha"], retainNonportable: true });
      migrate(exporting, "export", { retainNonportable: true });
      expect(() =>
        executeCronMigrationInDatabase(exporting, "store", {
          operationId: "back",
          phase: "hold",
          agentIds: ["alpha"],
          retainNonportable: true,
        }),
      ).toThrow(/held for migration move-a/);
    });

    it("replaces the target's projected system monitor with the snapshot's and refuses user job conflicts", () => {
      const monitor = (id: string): CronStoredJob => ({
        ...job(id),
        declarationKey: "heartbeat:alpha",
        schedule: { kind: "every", everyMs: 300_000, anchorMs: 1 },
        state: { nextRunAtMs: 300_001 },
      });
      const source = database(),
        target = database();
      upsertCronJobRow(source, "store", job(), 0);
      upsertCronJobRow(source, "store", monitor("heartbeat-source"), 1);
      migrate(source, "hold", { agentIds: ["alpha"] });
      const snapshot = expectDefined(migrate(source, "export").snapshot, "snapshot");
      upsertCronJobRow(target, "store", monitor("heartbeat-target"), 0);
      scratchRow(target, "heartbeat-target");
      upsertCronJobRow(target, "store", job("job-b", "beta"), 1);
      migrate(target, "stage", { agentIds: ["alpha"], snapshot });
      migrate(target, "activate");
      expect(jobIds(target)).toEqual(["heartbeat-source", "job-a", "job-b"]);
      expect(
        loadedCronStoreFromRows(loadCronRows(target, "store")).store.jobs.filter(
          (entry) => entry.declarationKey === "heartbeat:alpha",
        ),
      ).toHaveLength(1);
      expect(
        target.prepare("SELECT job_id FROM cron_job_scratch WHERE store_key = ?").all("store"),
      ).toEqual([]);

      const conflicting = database();
      upsertCronJobRow(conflicting, "store", job("job-a"), 0);
      expect(() => migrate(conflicting, "stage", { agentIds: ["alpha"], snapshot })).toThrow(
        /conflict/,
      );
      const foreignOwner = database();
      upsertCronJobRow(foreignOwner, "store", job("heartbeat-source", "beta"), 0);
      expect(() => migrate(foreignOwner, "stage", { agentIds: ["alpha"], snapshot })).toThrow(
        /conflict/,
      );
    });

    it("rejects the retain flag outside hold, export, and stage", () => {
      const db = database();
      upsertCronJobRow(db, "store", job(), 0);
      migrate(db, "hold", { agentIds: ["alpha"] });
      migrate(db, "export");
      expect(() => migrate(db, "retire", { retainNonportable: true })).toThrow(/only while/);
    });
  });

  it("refuses legacy jobs when no default agent can own them", () => {
    const source = database();
    const { agentId: _unowned, ...legacy } = job("legacy");
    upsertCronJobRow(source, "store", job(), 0);
    upsertCronJobRow(source, "store", legacy, 1);
    expect(() => migrate(source, "hold", { agentIds: ["alpha"] })).toThrow(/explicit owner/);
  });
});
