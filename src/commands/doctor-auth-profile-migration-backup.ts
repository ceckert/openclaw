import { isDeepStrictEqual } from "node:util";
import {
  inspectAuthProfileJsonCell,
  readAuthProfileJsonCellText,
} from "../agents/auth-profiles/sqlite-json.js";
import {
  inspectAuthProfileJsonCellReadOnly,
  readAuthProfileStateJsonTextReadOnly,
} from "../agents/auth-profiles/sqlite.js";
import type { PersistedAuthProfileStoreInspection } from "../agents/auth-profiles/types.js";
import type { DatabaseEngineInput } from "../infra/database-engine/types.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { agentEngineInput } from "../state/openclaw-agent-db-engine.js";
import { stateEngineInput } from "../state/openclaw-state-db-engine.js";

type AuthProfileMigrationBackupTarget = {
  databasePath: string;
  store: unknown;
  state: unknown;
  unreadableStateJson?: string;
};

type AuthProfileBackupSource = {
  inspect: (field: "store" | "state") => PersistedAuthProfileStoreInspection;
  stateText: () => string | undefined;
};

/** A migration backup is usable only while it holds the exact rows the migration planned from. */
function assertAuthProfileSourceMatchesPlan(
  target: AuthProfileMigrationBackupTarget,
  source: AuthProfileBackupSource,
): void {
  for (const field of ["store", "state"] as const) {
    if (field === "state" && target.unreadableStateJson !== undefined) {
      if (source.stateText() !== target.unreadableStateJson) {
        throw new Error(
          "Auth profile backup differs from the planned rotation-state source; retry Doctor.",
        );
      }
      continue;
    }
    const row = source.inspect(field);
    if (
      row.status === "unreadable" ||
      !isDeepStrictEqual(row.status === "readable" ? row.raw : null, target[field])
    ) {
      throw new Error("Auth profile backup differs from the planned source; retry Doctor.");
    }
  }
}

/** PostgreSQL owners keep their rows behind the SQLite anchor, so back up the engine store itself. */
async function backupPostgresAuthProfileOwner(params: {
  sourcePath: string;
  targetPath: string;
  input: NonNullable<DatabaseEngineInput>;
  assertCurrent: () => void;
  assertPlannedSource: () => void;
}): Promise<string> {
  const { capturePostgresBackup, fingerprintPostgresBackup } =
    await import("../snapshot/database-backup.js");
  const config = { database: { engine: "postgres" as const, postgres: params.input } };
  const before = await fingerprintPostgresBackup(params.sourcePath, config);
  params.assertPlannedSource();
  await capturePostgresBackup({
    sourcePath: params.sourcePath,
    directory: params.targetPath,
    profile: "exact",
    config,
    assertCurrent: params.assertCurrent,
  });
  if ((await fingerprintPostgresBackup(params.sourcePath, config)) !== before) {
    throw new Error("Auth profile backup differs from the planned source; retry Doctor.");
  }
  return params.targetPath;
}

/** Preserve one owner's auth rows, verified against the rows the migration planned from. */
export async function backupAuthProfileMigrationTarget(params: {
  target: AuthProfileMigrationBackupTarget;
  kind: "agent" | "shared-state";
  backupId: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<string> {
  const { target, kind } = params;
  const targetPath = `${target.databasePath}.auth-profile-migration-${params.backupId}`;
  const engine = kind === "shared-state" ? stateEngineInput() : agentEngineInput();
  if (engine) {
    const source = { kind, path: target.databasePath, env: params.env };
    return await backupPostgresAuthProfileOwner({
      sourcePath: target.databasePath,
      targetPath: `${targetPath}.postgres.bak`,
      input: engine,
      assertCurrent: params.assertCurrent,
      assertPlannedSource: () =>
        assertAuthProfileSourceMatchesPlan(target, {
          inspect: (field) => inspectAuthProfileJsonCellReadOnly(source, field),
          stateText: () => readAuthProfileStateJsonTextReadOnly(source),
        }),
    });
  }
  const backup = await createVerifiedSqliteSnapshot({
    sourcePath: target.databasePath,
    targetPath: `${targetPath}.bak`,
    preserveRowIds: true,
    beforePublish: params.assertCurrent,
    validate: (database) =>
      assertAuthProfileSourceMatchesPlan(target, {
        inspect: (field) => inspectAuthProfileJsonCell(database, field, kind),
        stateText: () => readAuthProfileJsonCellText(database, "state", kind),
      }),
  });
  return backup.path;
}
