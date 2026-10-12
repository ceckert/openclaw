import { DatabaseSync } from "node:sqlite";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

export async function createPredicateColumnPredecessorFixture(
  stateDir: string,
  retainedJson: string,
) {
  const current = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const pathname = current.path;
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname);
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
    DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
    INSERT INTO meeting_transcript_sessions
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
