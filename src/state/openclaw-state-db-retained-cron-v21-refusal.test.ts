import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPredicateColumnPredecessorFixture,
  installLegacyCronMigrationFixture,
} from "./openclaw-state-db-schema-v21.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const retainedJson =
  '{"completionRetention":{"idPrefix":"kept:","maxAgeMs":86400000,"maxEntries":2}}';

it.each(["partial predicates", "missing fence table"])(
  "refuses retained fork 21 with %s without rewriting valid rows or markers",
  async (layout) => {
    const stateDir = directories.make("state-fork-v21-refusal-");
    const pathname = await createPredicateColumnPredecessorFixture(stateDir, retainedJson);
    {
      using db = new DatabaseSync(pathname);
      db.exec("PRAGMA user_version = 21; UPDATE schema_meta SET schema_version = 21;");
      installLegacyCronMigrationFixture(db);
      db.exec(
        layout === "partial predicates"
          ? "ALTER TABLE meeting_transcript_sessions ADD COLUMN source_account_id TEXT"
          : "DROP TABLE cron_agent_migration_fences",
      );
    }
    expect(
      repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } }).warnings.join(
        "\n",
      ),
    ).toMatch(/Unrecognized retained cron schema-21 predicate layout/);
    using db = new DatabaseSync(pathname, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 21 });
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(21);
    expect(db.prepare("SELECT rowid, operation_id, status FROM cron_migrations").get()).toEqual({
      rowid: 1,
      operation_id: "held",
      status: "held",
    });
    expect(
      db.prepare("SELECT source_json, metadata_json FROM meeting_transcript_sessions").get(),
    ).toEqual({
      source_json: '{"accountId":"account","channelId":"channel"}',
      metadata_json: '{"agentId":"main"}',
    });
    expect(db.prepare("SELECT entry_json FROM delivery_queue_entries").get()?.entry_json).toBe(
      retainedJson,
    );
    expect(
      db
        .prepare("PRAGMA table_info(delivery_queue_entries)")
        .all()
        .map((row) => row.name),
    ).not.toContain("retention_id_prefix");
  },
);
