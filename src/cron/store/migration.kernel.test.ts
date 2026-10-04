import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronStoredJob } from "../types.js";
import {
  assertCronAgentMigrationAdmitted,
  assertCronJobMigrationMutationAdmitted,
  assertCronJobMigrationScratchAdmitted,
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
    db.prepare(`INSERT INTO cron_run_receipts (
      receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
      status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    const standingGrant = (db: DatabaseSync, jobId: string, revokedAtMs: number | null = null) => {
      const current = loadedCronStoreFromRows(loadCronRows(db, "store")).store.jobs.find(
        (entry) => entry.id === jobId,
      )!;
      db.prepare(`INSERT INTO operator_approvals (
        approval_id, resolution_ref, kind, status, presentation_json,
        reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
        created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason,
        resolved_at_ms, resolver_kind, resolver_id
      ) VALUES ('approval', ?, 'exec', 'allowed', '{}', '[]', '[]', 'epoch',
        1, 2, 1, 'allow-always', 'user', 1, 'device', 'owner')`).run(`ref${"a".repeat(40)}`);
      db.prepare(`INSERT INTO operator_approval_standing_grants (
        grant_id, minted_by_approval_id, agent_id, cron_job_id, job_config_revision,
        operation_binding, created_at_ms, revoked_at_ms
      ) SELECT 'grant', 'approval', 'alpha', job_id, ?,
        'binding', 1, ? FROM cron_jobs WHERE store_key = 'store' AND job_id = ?`).run(
        resolveCronJobConfigRevision(current),
        revokedAtMs,
        jobId,
      );
      db.prepare(`INSERT INTO operator_approval_standing_grant_generations
        SELECT 'grant', grant_definition_generation FROM cron_jobs
        WHERE store_key = 'store' AND job_id = ?`).run(jobId);
    };

    it.each([
      "on-exit",
      "standing approval",
      "legacy standing approval",
      "legacy stale revision",
      "legacy stale generation",
      "legacy foreign approval",
    ])("retains %s jobs and their scratch and authority through partial handoff", (kind) => {
      const source = database();
      upsertCronJobRow(source, "store", job(), 0);
      const { agentId: _owner, ...legacy } = job("job-x");
      upsertCronJobRow(
        source,
        "store",
        kind === "on-exit" ? hostBound("job-x") : kind.startsWith("legacy") ? legacy : job("job-x"),
        1,
      );
      if (kind !== "on-exit") {
        standingGrant(source, "job-x");
      }
      if (kind === "legacy stale revision") {
        source
          .prepare("UPDATE operator_approval_standing_grants SET job_config_revision = 'stale'")
          .run();
      } else if (kind === "legacy stale generation") {
        source
          .prepare(
            "UPDATE operator_approval_standing_grant_generations SET job_definition_generation = job_definition_generation + 1",
          )
          .run();
      } else if (kind === "legacy foreign approval") {
        source.prepare("UPDATE operator_approval_standing_grants SET agent_id = 'beta'").run();
      }
      const grants = source.prepare("SELECT * FROM operator_approval_standing_grants").all();
      scratchRow(source, "job-a");
      scratchRow(source, "job-x");
      const step = (phase: Parameters<typeof migrate>[1], extra = {}) =>
        executeCronMigrationInDatabase(
          source,
          "store",
          { operationId: "move-a", phase, ...extra },
          "alpha",
        );
      expect(() => step("hold", { agentIds: ["alpha"] })).toThrow(/on-exit|host approval/);
      step("hold", { agentIds: ["alpha"], retainNonportable: true });
      expect(() => step("export")).toThrow(/on-exit|host approval/);
      const snapshot = expectDefined(
        step("export", { retainNonportable: true }).snapshot,
        "partial snapshot",
      );
      expect(snapshot.jobs.map((entry) => entry.id)).toEqual(["job-a"]);
      expect(snapshot.retainedJobIds).toEqual(["job-x"]);
      expect(snapshot.scratch.map((entry) => entry.jobId)).toEqual(["job-a"]);
      expect(step("export", { retainNonportable: true }).snapshot).toEqual(snapshot);
      const target = database();
      migrate(target, "stage", { agentIds: ["alpha"], snapshot });
      migrate(target, "activate");
      expect(jobIds(target)).toEqual(["job-a"]);
      expect(target.prepare("SELECT * FROM operator_approval_standing_grants").all()).toEqual([]);
      migrate(source, "retire");
      expect(jobIds(source)).toEqual(["job-x"]);
      const retained = loadedCronStoreFromRows(loadCronRows(source, "store")).store.jobs[0]!;
      expect(source.prepare("SELECT * FROM operator_approval_standing_grants").all()).toEqual(
        kind === "legacy standing approval"
          ? grants.map((grant) => ({
              ...grant,
              job_config_revision: resolveCronJobConfigRevision(retained),
            }))
          : grants,
      );
      if (kind !== "on-exit") {
        expect(
          source
            .prepare(`SELECT g.grant_id FROM operator_approval_standing_grants g
            JOIN operator_approval_standing_grant_generations b USING (grant_id)
            JOIN cron_jobs j ON j.job_id = g.cron_job_id
            WHERE g.job_config_revision = ?
              AND g.agent_id = 'alpha'
              AND b.job_definition_generation = j.grant_definition_generation`)
            .all(resolveCronJobConfigRevision(retained)),
        ).toEqual(
          kind === "standing approval" || kind === "legacy standing approval"
            ? [{ grant_id: "grant" }]
            : [],
        );
      }
      expect(() => assertCronAgentMigrationAdmitted(source, "store", "alpha")).toThrow(/migration/);
      expect(
        source
          .prepare("SELECT job_id FROM cron_job_scratch WHERE store_key = ? ORDER BY job_id")
          .all("store"),
      ).toEqual([{ job_id: "job-x" }]);
    });

    it("does not block portable jobs with revoked standing approvals", () => {
      const source = database();
      upsertCronJobRow(source, "store", job(), 0);
      standingGrant(source, "job-a", 2);
      migrate(source, "hold", { agentIds: ["alpha"] });
      expect(migrate(source, "export").snapshot?.jobs.map((entry) => entry.id)).toEqual(["job-a"]);
    });

    it.each(["resume", "abort"] as const)(
      "preserves retirement through %s and runs retained jobs only after activation",
      (rollback) => {
        const home = database(),
          away = database();
        upsertCronJobRow(home, "store", job(), 0);
        upsertCronJobRow(home, "store", hostBound("job-x"), 1);
        scratchRow(home, "job-x");
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
        for (const operationId of ["cancel-one", "cancel-two"]) {
          step(home, operationId, "hold", { agentIds: ["alpha"], retainNonportable: true });
          if (rollback === "abort") {
            step(home, operationId, "stage", {
              agentIds: ["alpha"],
              retainNonportable: true,
              snapshot: { ...outbound, operationId },
            });
          }
          step(home, operationId, rollback);
          expect(jobIds(home)).toEqual(["job-x"]);
          expect(
            home.prepare("SELECT content FROM cron_job_scratch WHERE job_id = ?").get("job-x"),
          ).toEqual({ content: "notes for job-x" });
          expect(() => assertCronAgentMigrationAdmitted(home, "store", "alpha")).toThrow(/out/);
        }
        step(away, "back", "hold", { agentIds: ["alpha"] });
        const incoming = expectDefined(step(away, "back", "export").snapshot, "return snapshot");
        expect(() => step(home, "back", "hold", { agentIds: ["alpha"] })).toThrow(/on-exit/);
        step(home, "back", "hold", { agentIds: ["alpha"], retainNonportable: true });
        step(home, "cancel-one", rollback);
        expect(() => assertCronAgentMigrationAdmitted(home, "store", "alpha")).toThrow(/back/);
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
        step(home, "local", "hold", { agentIds: ["alpha"], retainNonportable: true });
        step(home, "local", "resume");
        expect(() => assertCronAgentMigrationAdmitted(home, "store", "alpha")).not.toThrow();
      },
    );

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

    it.each([
      ...[
        "activate",
        "abort",
        "same-id abort",
        "ordinary collision",
        "target grant",
        "late grant",
        "late conflict",
        "late declaration conflict",
      ].map((phase) => ({ phase, declarationKey: "heartbeat:alpha" })),
      ...["activate", "abort", "target only"].map((phase) => ({
        phase,
        declarationKey: "memory-core:memory-dreaming-promotion",
      })),
      ...["heartbeat-task:alpha:daily", "agent:alpha:daily"].map((declarationKey) => ({
        phase: "operator content",
        declarationKey,
      })),
    ])("preserves $declarationKey until cutover: $phase", ({ phase, declarationKey }) => {
      const monitor = (id: string): CronStoredJob => ({
        ...job(id),
        declarationKey,
        schedule: { kind: "every", everyMs: 300_000, anchorMs: 1 },
        state: { nextRunAtMs: 300_001 },
      });
      const source = database(),
        target = database();
      const targetStep = (nextPhase: Parameters<typeof migrate>[1], extra = {}) =>
        executeCronMigrationInDatabase(
          target,
          "store",
          { operationId: "move-a", phase: nextPhase, ...extra },
          "alpha",
        );
      upsertCronJobRow(source, "store", job(), 0);
      if (phase !== "target only") {
        upsertCronJobRow(source, "store", monitor("heartbeat-source"), 1);
        scratchRow(source, "heartbeat-source");
      }
      if (phase === "ordinary collision") {
        upsertCronJobRow(source, "store", job("heartbeat-target"), 2);
      }
      migrate(source, "hold", { agentIds: ["alpha"] });
      const snapshot = expectDefined(migrate(source, "export").snapshot, "snapshot");
      const targetId = phase === "same-id abort" ? "heartbeat-source" : "heartbeat-target";
      const targetJob = monitor(targetId);
      if (declarationKey === "memory-core:memory-dreaming-promotion") {
        delete targetJob.agentId;
      }
      upsertCronJobRow(target, "store", targetJob, 0);
      scratchRow(target, targetId);
      target
        .prepare("UPDATE cron_job_scratch SET content = ? WHERE job_id = ?")
        .run("target monitor notes", targetId);
      upsertCronJobRow(target, "store", job("job-b", "beta"), 1);
      const beforeRows = loadCronRows(target, "store");
      const beforeScratch = target.prepare("SELECT * FROM cron_job_scratch").all();
      if (["ordinary collision", "target grant", "operator content"].includes(phase)) {
        if (phase === "target grant") {
          standingGrant(target, targetId);
        }
        const grants = target.prepare("SELECT * FROM operator_approval_standing_grants").all();
        expect(() =>
          targetStep("stage", { agentIds: ["alpha"], snapshot, retainNonportable: true }),
        ).toThrow(
          phase === "target grant"
            ? /host approval/
            : phase === "operator content"
              ? /not retained/
              : /conflict/,
        );
        expect(loadCronRows(target, "store")).toEqual(beforeRows);
        expect(target.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(beforeScratch);
        expect(target.prepare("SELECT * FROM operator_approval_standing_grants").all()).toEqual(
          grants,
        );
        return;
      }
      targetStep("stage", { agentIds: ["alpha"], snapshot });
      expect(loadCronRows(target, "store", new Set([targetId]))).toEqual(
        beforeRows.filter((row) => row.job_id === targetId),
      );
      expect(target.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(beforeScratch);
      if (phase.startsWith("late")) {
        if (phase === "late grant") {
          standingGrant(target, targetId);
        } else {
          const conflicting =
            phase === "late conflict"
              ? job("heartbeat-source", "beta")
              : { ...monitor("heartbeat-source"), declarationKey: "heartbeat:unrelated" };
          upsertCronJobRow(target, "store", conflicting, 3);
        }
        const stagedRows = loadCronRows(target, "store");
        const grants = target.prepare("SELECT * FROM operator_approval_standing_grants").all();
        expect(() => targetStep("activate")).toThrow(
          phase === "late grant" ? /host approval/ : /conflict/,
        );
        expect(loadCronRows(target, "store")).toEqual(stagedRows);
        expect(target.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(beforeScratch);
        expect(target.prepare("SELECT * FROM operator_approval_standing_grants").all()).toEqual(
          grants,
        );
        expect(() => assertCronAgentMigrationAdmitted(target, "store", "alpha")).toThrow(
          /migration/,
        );
        return;
      }
      if (phase === "target only") {
        targetStep("activate");
        expect(jobIds(target)).toEqual([targetId, "job-a", "job-b"]);
        expect(loadCronRows(target, "store", new Set([targetId]))).toEqual(
          beforeRows.filter((row) => row.job_id === targetId),
        );
        expect(target.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(beforeScratch);
        return;
      }
      if (phase !== "activate") {
        targetStep("abort");
        targetStep("abort");
        expect(loadCronRows(target, "store")).toEqual(beforeRows);
        expect(target.prepare("SELECT * FROM cron_job_scratch").all()).toEqual(beforeScratch);
        return;
      }
      targetStep("activate");
      targetStep("activate");
      expect(jobIds(target)).toEqual(["heartbeat-source", "job-a", "job-b"]);
      expect(
        loadedCronStoreFromRows(loadCronRows(target, "store")).store.jobs.filter(
          (entry) => entry.declarationKey === declarationKey,
        ),
      ).toHaveLength(1);
      expect(
        target.prepare("SELECT job_id FROM cron_job_scratch WHERE store_key = ?").all("store"),
      ).toEqual([{ job_id: "heartbeat-source" }]);
      expect(
        target
          .prepare("SELECT content FROM cron_job_scratch WHERE job_id = ?")
          .get("heartbeat-source"),
      ).toEqual({ content: "notes for heartbeat-source" });

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

  describe("agent-less job mutations", () => {
    const { agentId: _unowned, ...agentless } = job("dreaming");

    it("are held while a migration is in flight and admitted once only retired fences remain", () => {
      const source = database(),
        target = database();
      upsertCronJobRow(source, "store", job(), 0);
      migrate(source, "hold", { agentIds: ["alpha"] });
      expect(() => assertCronJobMigrationMutationAdmitted(source, "store", agentless)).toThrow(
        /held for migration move-a/,
      );
      const snapshot = migrate(source, "export").snapshot;
      expect(() => assertCronJobMigrationMutationAdmitted(source, "store", agentless)).toThrow(
        /held for migration move-a/,
      );
      migrate(target, "stage", { agentIds: ["alpha"], snapshot });
      upsertCronJobRow(target, "store", agentless, 1);
      expect(() =>
        assertCronJobMigrationScratchAdmitted(target, "store", agentless.id),
      ).not.toThrow();
      expect(() => assertCronJobMigrationMutationAdmitted(target, "store", agentless)).toThrow(
        /held for migration move-a/,
      );
      migrate(source, "retire");
      upsertCronJobRow(source, "store", agentless, 1);
      expect(() =>
        assertCronJobMigrationScratchAdmitted(source, "store", agentless.id),
      ).not.toThrow();
      expect(() =>
        assertCronJobMigrationMutationAdmitted(source, "store", agentless),
      ).not.toThrow();
      expect(() => assertCronJobMigrationMutationAdmitted(source, "store", job())).toThrow(
        /alpha is held for migration move-a/,
      );
      migrate(target, "activate");
      expect(() =>
        assertCronJobMigrationMutationAdmitted(target, "store", agentless),
      ).not.toThrow();
      expect(() => assertCronJobMigrationMutationAdmitted(target, "store", job())).not.toThrow();
    });

    it("stay held by a new in-flight migration beside a retired fence", () => {
      const source = database();
      upsertCronJobRow(source, "store", job(), 0);
      upsertCronJobRow(source, "store", job("other", "beta"), 1);
      migrate(source, "hold", { agentIds: ["alpha"] });
      migrate(source, "export");
      migrate(source, "retire");
      executeCronMigrationInDatabase(source, "store", {
        operationId: "move-b",
        phase: "hold",
        agentIds: ["beta"],
      });
      expect(() => assertCronJobMigrationMutationAdmitted(source, "store", agentless)).toThrow(
        /beta is held for migration move-b/,
      );
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
