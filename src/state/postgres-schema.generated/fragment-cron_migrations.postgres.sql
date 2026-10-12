-- Generated lazy feature; create dependencies first.

BEGIN;

SET LOCAL standard_conforming_strings = on;

CREATE TABLE "openclaw_state"."cron_agent_migration_fences" (
  "store_key" text COLLATE "C" NOT NULL,
  "agent_id" text COLLATE "C" NOT NULL,
  "operation_id" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("store_key", "agent_id")
);

CREATE TABLE "openclaw_state"."cron_migrations" (
  "store_key" text COLLATE "C" NOT NULL,
  "operation_id" text COLLATE "C" NOT NULL,
  "agent_ids_json" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL,
  "snapshot_json" text COLLATE "C",
  "snapshot_digest" text COLLATE "C",
  PRIMARY KEY ("store_key", "operation_id"),
  CHECK (("status" IN ('held', 'exported', 'staged', 'activated', 'resumed', 'retired', 'aborted')))
);

ALTER TABLE "openclaw_state"."cron_agent_migration_fences" ADD FOREIGN KEY ("store_key", "operation_id") REFERENCES "openclaw_state"."cron_migrations" ("store_key", "operation_id") ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE;

COMMIT;
