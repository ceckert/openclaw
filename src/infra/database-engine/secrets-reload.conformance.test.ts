import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { expect, it } from "vitest";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../../plugins/installed-plugin-index-records.js";
import { createPluginManifestRecordFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createResolverContext } from "../../secrets/runtime-shared.js";
import { resolveRuntimeWebTools } from "../../secrets/runtime-web-tools.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "../../state/openclaw-state-db.postgres-fixture.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
it.skipIf(!connection)(
  "resolves web providers from a cold installed-index cache with PostgreSQL global state",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-secrets-global-postgres-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const config = {
      database: { engine: "postgres" as const, postgres: { connection: connection! } },
      tools: { web: { search: { enabled: true, provider: "parallel-free" } } },
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      installPostgresStateFixture(connection!, `web_${process.pid}_${Date.now()}`);
      const opened = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
      namespace = getPostgresPhysicalFacts(opened.db)?.namespace;
      clearLoadInstalledPluginIndexInstallRecordsCache();
      const result = await resolveRuntimeWebTools({
        sourceConfig: config,
        resolvedConfig: structuredClone(config),
        context: createResolverContext({
          sourceConfig: config,
          env,
          manifestRegistry: {
            plugins: [
              createPluginManifestRecordFixture({
                id: "parallel",
                rootDir: path.resolve("extensions/parallel"),
                contracts: { webSearchProviders: ["parallel", "parallel-free"] },
              }),
            ],
          },
        }),
      });
      expect(result.metadata.search.selectedProvider).toBe("parallel-free");
      expect(result.degradedOwners).toEqual([]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await cleanupPostgresStateFixture(client, resolveOpenClawStateSqlitePath(env), namespace);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
