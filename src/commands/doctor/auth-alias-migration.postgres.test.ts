import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiKeyCredential as apiKey } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeRepairLegacyAuthProfileStores,
} from "../doctor-auth-flat-profiles.js";

installDatabaseProcessRole("cli-oneshot");

describe.skipIf(!mixedAgentConnection).each(["shared-state", "agent"] as const)(
  "Doctor stored auth alias migration on PostgreSQL (%s)",
  (kind) => {
    const fixture = useMixedAgentPair("postgres", "postgres");

    function seedLegacyAlias() {
      const agentDir =
        kind === "agent" ? path.join(fixture.root, "agents", "worker", "agent") : undefined;
      const database = withEngineStoreAdmission(() =>
        agentDir ? openOpenClawAgentDatabase({ agentId: "worker" }) : openOpenClawStateDatabase(),
      );
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        auth: {
          profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
          order: { "claude-cli": ["claude-cli:work"] },
        },
      };
      const original: AuthProfileStore = {
        version: 1,
        profiles: { "claude-cli:work": apiKey("claude-cli", "synthetic-work-key") },
        order: { "claude-cli": ["claude-cli:work"] },
      };
      const write = (store: AuthProfileStore) =>
        withEngineStoreAdmission(() =>
          runAuthProfileWriteTransaction(agentDir, (owner) =>
            writePersistedAuthProfileStoreRaw(store, agentDir, owner),
          ),
        );
      write(original);
      const read = () =>
        withEngineStoreAdmission(() =>
          agentDir
            ? readPersistedAuthProfileStoreRaw(agentDir)
            : readPersistedSharedAuthProfileStoreRaw(process.env),
        );
      const repair = () =>
        maybeRepairLegacyAuthProfileStores({
          cfg,
          env: process.env,
          profileIdMap: collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: process.env }),
        });
      return { database, original, read, repair, write };
    }

    it("backs up the PostgreSQL auth rows and migrates them", async () => {
      const { database, read, repair } = seedLegacyAlias();

      const result = await repair();

      expect(result.warnings).toEqual([]);
      expect(read()).toMatchObject({
        profiles: { "anthropic:work": apiKey("anthropic", "synthetic-work-key") },
        order: { anthropic: ["anthropic:work"] },
      });
      const backups = fs
        .readdirSync(path.dirname(database.path))
        .filter((name) =>
          name.startsWith(`${path.basename(database.path)}.auth-profile-migration-`),
        );
      expect(backups).toHaveLength(1);
      const backupPath = path.join(path.dirname(database.path), backups[0]!);
      expect(result.changes).toContain(`Saved auth profile migration backup: ${backupPath}.`);
      const captured = listDirectoryTreeStrictSync(backupPath).filter(({ dirent }) =>
        dirent.isFile(),
      );
      const names = captured.map(({ relativePath }) => relativePath);
      expect(names).toContain("anchor.sqlite");
      expect(names).not.toContain(".pending");
      expect(
        captured.some(({ relativePath }) =>
          fs.readFileSync(path.join(backupPath, relativePath)).includes("claude-cli:work"),
        ),
      ).toBe(true);
    });

    it("refuses to migrate when the PostgreSQL rows change while the backup is captured", async () => {
      const { original, read, repair, write } = seedLegacyAlias();
      const changed: AuthProfileStore = {
        ...original,
        profiles: { "claude-cli:work": apiKey("claude-cli", "synthetic-rotated-key") },
      };
      const capture = databaseBackup.capturePostgresBackup;
      vi.spyOn(databaseBackup, "capturePostgresBackup").mockImplementationOnce(async (params) => {
        write(changed);
        return capture(params);
      });

      await expect(repair()).rejects.toThrow(
        "Auth profile backup differs from the planned source; retry Doctor.",
      );
      expect(read()).toEqual(changed);
    });
  },
);
