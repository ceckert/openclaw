import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import type { CronStoredJob } from "../types.js";
import {
  readCronMigration,
  readCronMigrationMetadata,
  writeCronMigration,
  type MigrationRecord,
} from "./migration-persistence.js";
import {
  executeCronMigrationInDatabase,
  assertCronAgentMigrationAdmitted,
} from "./migration.kernel.js";
import { loadCronRows, upsertCronJobRow } from "./row-codec.js";

let db: DatabaseSync;
beforeAll(() => {
  db = new DatabaseSync(":memory:");
  runSqliteImmediateTransactionSync(db, () => db.exec(OPENCLAW_STATE_SCHEMA_SQL));
});
afterAll(() => db.close());

function job(message = "synthetic"): CronStoredJob {
  return {
    id: "portable",
    agentId: "alpha",
    name: "portable",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 60000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "announce" },
    state: { nextRunAtMs: 60000 },
  };
}

function migrate(storeKey: string, request: Parameters<typeof executeCronMigrationInDatabase>[2]) {
  return runSqliteImmediateTransactionSync(db, () =>
    executeCronMigrationInDatabase(db, storeKey, request),
  );
}

function record(storeKey: string, snapshotJson: string | null): MigrationRecord {
  return {
    store_key: storeKey,
    operation_id: "boundary",
    agent_ids_json: '["alpha"]',
    status: "held",
    snapshot_json: snapshotJson,
    snapshot_digest: null,
  };
}

it.each([17, Number.MAX_SAFE_INTEGER])(
  "refuses a stored snapshot chunk count of %s before reading its chunks",
  (snapshotChunks) => {
    const original = record(`invalid-count-${snapshotChunks}`, null);
    runSqliteImmediateTransactionSync(db, () => writeCronMigration(db, original));
    expect(readCronMigration(db, original.store_key, original.operation_id)).toEqual(original);
    db.prepare(
      "UPDATE plugin_state_entries SET value_json = json_set(value_json, '$.snapshot_chunks', ?) WHERE plugin_id = 'core:cron-custody' AND json_extract(value_json, '$.store_key') = ?",
    ).run(snapshotChunks, original.store_key);
    expect(() => readCronMigrationMetadata(db, original.store_key, original.operation_id)).toThrow(
      "Invalid retained cron custody operation",
    );
    expect(() => readCronMigration(db, original.store_key, original.operation_id)).toThrow(
      "Invalid retained cron custody operation",
    );
  },
);

it("preserves the 8 MiB boundary and refuses a native-valid chunk that decodes beyond it", () => {
  const original = record("decoded-boundary", "x".repeat(8 * 1024 * 1024));
  runSqliteImmediateTransactionSync(db, () => writeCronMigration(db, original));
  expect(
    readCronMigrationMetadata(db, original.store_key, original.operation_id)?.snapshot_chunks,
  ).toBe(16);
  expect(readCronMigration(db, original.store_key, original.operation_id)).toEqual(original);
  const chunk = db
    .prepare(
      "SELECT entry_key FROM plugin_state_entries WHERE plugin_id = 'core:cron-custody' AND namespace = '@retained.cron-custody.snapshots' ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  if (!chunk || typeof chunk.entry_key !== "string") {
    throw new Error("Boundary fixture has no native snapshot chunks");
  }
  try {
    for (const [extraBytes, refusal] of [
      [1, "Cron custody snapshot exceeds the 8 MiB transfer limit"],
      [4, "Cron custody snapshot chunk exceeds the 512 KiB encoding"],
    ] as const) {
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        JSON.stringify(Buffer.alloc(512 * 1024 + extraBytes, "x").toString("base64")),
        chunk.entry_key,
      );
      expect(() => readCronMigration(db, original.store_key, original.operation_id)).toThrow(
        refusal,
      );
    }
  } finally {
    runSqliteImmediateTransactionSync(db, () =>
      writeCronMigration(db, { ...original, snapshot_json: null }),
    );
  }
});

it("roundtrips null and empty snapshot text without conflating their custody", () => {
  const original = record("empty-boundary", null);
  runSqliteImmediateTransactionSync(db, () => writeCronMigration(db, original));
  expect(readCronMigration(db, original.store_key, original.operation_id)).toEqual(original);
  expect(readCronMigrationMetadata(db, original.store_key, original.operation_id)).toMatchObject({
    snapshot_chunks: 0,
    snapshot_content_sha256: null,
  });
  const empty = { ...original, snapshot_json: "" };
  runSqliteImmediateTransactionSync(db, () => writeCronMigration(db, empty));
  expect(readCronMigration(db, original.store_key, original.operation_id)).toEqual(empty);
  expect(readCronMigrationMetadata(db, original.store_key, original.operation_id)).toMatchObject({
    snapshot_chunks: 1,
    snapshot_content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  runSqliteImmediateTransactionSync(db, () => writeCronMigration(db, original));
  expect(readCronMigration(db, original.store_key, original.operation_id)).toEqual(original);
  expect(readCronMigrationMetadata(db, original.store_key, original.operation_id)).toMatchObject({
    snapshot_chunks: 0,
    snapshot_content_sha256: null,
  });
});

it("preserves multi-value UTF-8 snapshots and scratch tombstones under native KV limits", () => {
  const original = job("🌒".repeat(300_000));
  upsertCronJobRow(db, "large-source", original, 0);
  db.prepare("INSERT INTO cron_job_scratch VALUES (?, ?, NULL, 7, ?, 8)").run(
    "large-source",
    original.id,
    "a".repeat(64),
  );
  migrate("large-source", { operationId: "large", phase: "hold", agentIds: ["alpha"] });
  const snapshot = migrate("large-source", { operationId: "large", phase: "export" }).snapshot;
  expect(snapshot).toEqual({
    version: 1,
    operationId: "large",
    agentIds: ["alpha"],
    jobs: [original],
    scratch: [
      {
        jobId: original.id,
        content: null,
        revision: 7,
        sourceSha256: "a".repeat(64),
        updatedAtMs: 8,
      },
    ],
  });
  expect(readCronMigration(db, "large-source", "large")?.snapshot_json).toBe(
    JSON.stringify(snapshot),
  );
  expect(
    db
      .prepare(
        "SELECT max(length(CAST(value_json AS BLOB))) AS bytes, max(expires_at) AS expiry FROM plugin_state_entries WHERE plugin_id = 'core:cron-custody'",
      )
      .get(),
  ).toMatchObject({ bytes: expect.any(Number), expiry: null });
  expect(
    Number(
      db
        .prepare(
          "SELECT max(length(CAST(value_json AS BLOB))) AS bytes FROM plugin_state_entries WHERE plugin_id = 'core:cron-custody'",
        )
        .get()?.bytes,
    ),
  ).toBeLessThanOrEqual(1_048_576);
  migrate("large-target", { operationId: "large", phase: "stage", agentIds: ["alpha"], snapshot });
  expect(() => assertCronAgentMigrationAdmitted(db, "large-target", "alpha")).toThrow(/large/);
  migrate("large-target", { operationId: "large", phase: "activate" });
  expect(
    db
      .prepare(
        "SELECT content, revision, source_sha256, updated_at_ms FROM cron_job_scratch WHERE store_key = 'large-target'",
      )
      .get(),
  ).toEqual({ content: null, revision: 7, source_sha256: "a".repeat(64), updated_at_ms: 8 });
  migrate("large-source", { operationId: "large", phase: "retire" });
  expect(readCronMigration(db, "large-target", "large")?.snapshot_json).toBeNull();
  expect(readCronMigration(db, "large-source", "large")?.snapshot_json).toBeNull();
  expect(
    db
      .prepare(
        "SELECT count(*) AS count FROM plugin_state_entries WHERE plugin_id = 'core:cron-custody' AND namespace = '@retained.cron-custody.snapshots'",
      )
      .get()?.count,
  ).toBe(0);
});

it("rolls back target jobs, scratch, snapshot chunks and custody together when persistence fails", () => {
  upsertCronJobRow(db, "fault-source", job(), 0);
  migrate("fault-source", { operationId: "fault", phase: "hold", agentIds: ["alpha"] });
  const snapshot = migrate("fault-source", { operationId: "fault", phase: "export" }).snapshot;
  db.exec(`CREATE TEMP TRIGGER reject_custody_snapshot
    BEFORE INSERT ON plugin_state_entries
    WHEN NEW.namespace = '@retained.cron-custody.snapshots'
    BEGIN SELECT RAISE(ABORT, 'synthetic snapshot write failure'); END;`);
  try {
    expect(() =>
      migrate("fault-target", {
        operationId: "fault",
        phase: "stage",
        agentIds: ["alpha"],
        snapshot,
      }),
    ).toThrow(/synthetic snapshot write failure/);
    expect(loadCronRows(db, "fault-target")).toEqual([]);
    expect(
      db.prepare("SELECT * FROM cron_job_scratch WHERE store_key = 'fault-target'").all(),
    ).toEqual([]);
    expect(readCronMigration(db, "fault-target", "fault")).toBeUndefined();
    expect(() => assertCronAgentMigrationAdmitted(db, "fault-target", "alpha")).not.toThrow();
  } finally {
    db.exec("DROP TRIGGER reject_custody_snapshot");
  }
  migrate("fault-target", { operationId: "fault", phase: "stage", agentIds: ["alpha"], snapshot });
  expect(() => assertCronAgentMigrationAdmitted(db, "fault-target", "alpha")).toThrow(/fault/);
});
