import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { openPostgresEngineTestStore } from "../infra/database-engine/engine-store.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import {
  openExistingStatePostgresConnection,
  stateEngineSchema,
} from "./openclaw-state-db-engine.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "./openclaw-state-db.postgres-fixture.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const version40 = expectDefined(
  stateEngineSchema.postgresMigrations?.find((migration) => migration.version === 40),
  "State schema 40 migration",
);
const predecessor = {
  ...stateEngineSchema,
  ...version40.fromSchema,
  version: 39,
  postgres: version40.fromSchema.postgres.replace(/\n {2}"bootstrap_deferred" bigint,/u, ""),
  postgresAdditiveColumns: [],
  postgresMigrations: [],
};

async function withPreDeferralStore(
  run: (fixture: {
    client: pg.Client;
    namespace: string;
    options: { path: string; env: NodeJS.ProcessEnv };
    pathname: string;
    readColumn: () => Promise<unknown[]>;
  }) => Promise<void>,
) {
  const directory = tempDirs.make("state-bootstrap-deferral-");
  const pathname = path.join(directory, "state", "openclaw.sqlite");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
  };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
  );
  const options = { path: pathname, env };
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  installPostgresStateFixture(connection!, "state_bootstrap_deferral");
  let namespace: string | undefined;
  try {
    fs.mkdirSync(path.dirname(pathname));
    const anchor = openNodeSqliteDatabase(pathname);
    try {
      namespace = withEngineStoreAdmission(() => {
        const db = openPostgresEngineTestStore({
          anchor,
          schema: predecessor,
          input: { connection: connection!, schemaPrefix: "state_bootstrap_deferral" },
        });
        try {
          db.exec(`INSERT INTO schema_meta
            (meta_key, role, schema_version, created_at, updated_at)
            VALUES ('primary', 'global', 39, 1, 1);
            INSERT INTO workspace_setup_state
              (workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at)
              VALUES ('retained', '/fixture/workspace', 1, '2026-11-09T00:00:00.000Z',
                '2026-11-09T00:01:00.000Z', 7);`);
          return expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL facts").namespace;
        } finally {
          db.close();
        }
      });
    } finally {
      anchor.close();
      retireSqliteDatabaseAdmissionForPath(pathname);
    }
    const store = namespace;
    await run({
      client,
      namespace,
      options,
      pathname,
      readColumn: async () =>
        (
          await client.query(
            `SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = 'workspace_setup_state'
               AND column_name = 'bootstrap_deferred'`,
            [store],
          )
        ).rows,
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await cleanupPostgresStateFixture(client, pathname, namespace);
  }
}

describe.skipIf(!connection)("PostgreSQL shared state sealed before bootstrap deferral", () => {
  it("admits a schema-39 store sealed before bootstrap deferral and keeps its setup rows", async () => {
    await withPreDeferralStore(async ({ client, namespace, options, pathname, readColumn }) => {
      const readSetupRows = () =>
        withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              db
                .prepare(
                  `SELECT workspace_key, workspace_path, bootstrap_seeded_at, setup_completed_at,
                    bootstrap_deferred FROM workspace_setup_state`,
                )
                .all(),
            options,
          ),
        );
      const seal = async () =>
        (await client.query(`SELECT ddl_hash FROM "${namespace}".openclaw_schema_meta`)).rows;
      const predecessorSeal = await seal();
      const inspected = withEngineStoreAdmission(() =>
        openExistingStatePostgresConnection(pathname),
      );
      expect(inspected?.close()).toBe(true);
      retireSqliteDatabaseAdmissionForPath(pathname);
      expect(await readColumn()).toEqual([]);
      expect(await seal()).toEqual(predecessorSeal);

      expect(readSetupRows()).toEqual([
        {
          workspace_key: "retained",
          workspace_path: "/fixture/workspace",
          bootstrap_seeded_at: "2026-11-09T00:00:00.000Z",
          setup_completed_at: "2026-11-09T00:01:00.000Z",
          bootstrap_deferred: null,
        },
      ]);
      expect(await readColumn()).toEqual([
        { data_type: "bigint", is_nullable: "YES", column_default: null },
      ]);
      expect(await seal()).not.toEqual(predecessorSeal);
      closeOpenClawStateDatabaseForTest();
      retireSqliteDatabaseAdmissionForPath(pathname);
      expect(readSetupRows()).toHaveLength(1);
    });
  });

  it("completes a predecessor for a writer while its inspection admission is retained", async () => {
    await withPreDeferralStore(async ({ options, pathname, readColumn }) => {
      const inspected = withEngineStoreAdmission(() =>
        openExistingStatePostgresConnection(pathname),
      );
      try {
        expect(await readColumn()).toEqual([]);
        expect(
          withEngineStoreAdmission(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                db
                  .prepare(`SELECT workspace_key, bootstrap_deferred FROM workspace_setup_state`)
                  .all(),
              options,
            ),
          ),
        ).toEqual([{ workspace_key: "retained", bootstrap_deferred: null }]);
        expect(await readColumn()).toEqual([
          { data_type: "bigint", is_nullable: "YES", column_default: null },
        ]);
      } finally {
        expect(inspected?.close()).toBe(true);
      }
    });
  });

  it.each([
    {
      shape: "a column added outside OpenClaw under the predecessor seal",
      sql: "ALTER TABLE workspace_setup_state ADD COLUMN bootstrap_deferred bigint",
      error: /schema drift detected\. /u,
    },
    {
      shape: "an integer column on an unsealed store",
      sql: `ALTER TABLE workspace_setup_state ADD COLUMN bootstrap_deferred integer;
        UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL`,
      error: /schema drift detected against generated DDL/u,
    },
    {
      shape: "an unrelated column on an unsealed predecessor",
      sql: `ALTER TABLE workspace_setup_state ADD COLUMN unrelated text;
        UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL, server_major = NULL`,
      error: /schema drift detected against generated DDL/u,
    },
  ])("refuses $shape without changing it", async ({ sql, error }) => {
    await withPreDeferralStore(async ({ client, namespace, options, readColumn }) => {
      await client.query(`BEGIN; SET LOCAL search_path TO "${namespace}"; ${sql}; COMMIT;`);
      const before = await readColumn();
      expect(() =>
        withEngineStoreAdmission(() => runOpenClawStateWriteTransaction(() => undefined, options)),
      ).toThrow(error);
      expect(await readColumn()).toEqual(before);
    });
  });
});
