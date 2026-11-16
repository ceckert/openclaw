import { DatabaseSync } from "node:sqlite";
import { LEGACY_CRON_MIGRATION_SCHEMA_SQL } from "../cron/store/migration-legacy.js";
import type { MigrationFence, MigrationRecord } from "../cron/store/migration-persistence.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { STATE_CURSOR_TABLES_V22 } from "./openclaw-state-db-schema-v22-columns.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
} from "./openclaw-state-schema.test-support.js";

export function installLegacyCronMigrationFixture(
  db: DatabaseSync,
  records: MigrationRecord[] = [
    {
      store_key: "synthetic",
      operation_id: "held",
      agent_ids_json: '["main"]',
      status: "held",
      snapshot_json: null,
      snapshot_digest: null,
    },
  ],
  fences: MigrationFence[] = [{ store_key: "synthetic", agent_id: "main", operation_id: "held" }],
): void {
  if (readStateSchemaContentVersion(db) === CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION) {
    addPreCutoverClientCredentialTablesForTest(db);
    const predecessor = CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1;
    db.exec(`PRAGMA user_version = ${predecessor};
      UPDATE schema_meta SET schema_version = ${predecessor};
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
  }
  db.exec(LEGACY_CRON_MIGRATION_SCHEMA_SQL);
  for (const row of records) {
    db.prepare("INSERT INTO cron_migrations VALUES (?, ?, ?, ?, ?, ?)").run(
      row.store_key,
      row.operation_id,
      row.agent_ids_json,
      row.status,
      row.snapshot_json,
      row.snapshot_digest,
    );
  }
  for (const row of fences) {
    db.prepare("INSERT INTO cron_agent_migration_fences VALUES (?, ?, ?)").run(
      row.store_key,
      row.agent_id,
      row.operation_id,
    );
  }
}

export function rewindStateFixtureToV20(db: DatabaseSync): void {
  restorePreTemplateStateIdentifiersForTest(db);
  addPreCutoverClientCredentialTablesForTest(db);
  for (const table of STATE_CURSOR_TABLES_V22) {
    if (!tableExists(db, table)) {
      continue;
    }
    const index =
      table === "operator_approvals"
        ? "idx_operator_approvals_cursor_id"
        : `${table}_cursor_id_idx`;
    db.exec(`DROP INDEX ${index}; ALTER TABLE ${table} DROP COLUMN cursor_id`);
  }
  db.exec(`DROP INDEX idx_acp_sessions_resume_agent;
    DROP INDEX idx_acp_sessions_resume_acpx;
    ALTER TABLE acp_sessions DROP COLUMN resume_agent_session_id;
    ALTER TABLE acp_sessions DROP COLUMN resume_acpx_session_id;
    CREATE INDEX idx_acp_sessions_resume_agent ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.agentSessionId'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)));
    CREATE INDEX idx_acp_sessions_resume_acpx ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.acpxSessionId'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)));`);
  db.exec(`DROP INDEX idx_meeting_transcript_sessions_source;
    DROP INDEX idx_meeting_transcript_sessions_account;
    DROP INDEX idx_meeting_transcript_sessions_agent;
    DROP INDEX idx_delivery_queue_bounded_retention;`);
  for (const column of [
    "source_account_id",
    "source_guild_id",
    "source_channel_id",
    "source_meeting_url",
    "source_thread_ts",
    "source_file_id",
    "metadata_agent_id",
  ]) {
    db.exec(`ALTER TABLE meeting_transcript_sessions DROP COLUMN ${column}`);
  }
  db.exec("ALTER TABLE meeting_transcript_summaries DROP COLUMN overview");
  for (const column of ["retention_id_prefix", "retention_max_age_ms", "retention_max_entries"]) {
    db.exec(`ALTER TABLE delivery_queue_entries DROP COLUMN ${column}`);
  }
  db.exec(`PRAGMA user_version = 20;
    UPDATE schema_meta SET schema_version = 20;
    DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
}

export async function createPredicateColumnPredecessorFixture(
  stateDir: string,
  retainedJson: string,
) {
  const current = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const pathname = current.path;
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname);
  rewindStateFixtureToV20(db);
  db.exec(`INSERT INTO meeting_transcript_sessions
      (session_id, started_at, selector, export_key, session_slug, provider_id, source_json, metadata_json, created_at_ms, updated_at_ms)
      VALUES ('capture', '2026-10-01', 'capture-selector', 'capture-export', 'capture-slug', 'synthetic', '{"accountId":"account","channelId":"channel"}', '{"agentId":"main"}', 1, 1);
    INSERT INTO meeting_transcript_summaries
      (session_id, session_started_at, summary_json, utterance_count)
      VALUES ('capture', '2026-10-01', '{"overview":"retained overview"}', 0);`);
  const now = Date.now();
  db.prepare(`INSERT INTO delivery_queue_entries
    (queue_name, id, status, recovery_state, entry_json, enqueued_at, updated_at)
    VALUES ('synthetic', 'kept:row', 'completed', 'completed_bounded', ?, ?, ?)`).run(
    retainedJson,
    now,
    now,
  );
  return pathname;
}
