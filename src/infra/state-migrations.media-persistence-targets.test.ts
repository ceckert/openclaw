import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournalAsync,
} from "../state/agent-deletion-journal.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";
import { createLegacyStateMigrationStepReceipt } from "./state-migrations.messages.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = 16;
let stateDir: string;
let env: NodeJS.ProcessEnv;
const tempDir = () => fs.realpathSync.native(makeTempDir(tempDirs, "media-targets-"));
const registrations = (includeIncompatibleSchemaVersions = false) =>
  listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions });
const ready = (configuredAgentDatabaseTargets: { agentId: string; path: string }[] = []) =>
  assertOpenClawDatabasesReady({ env, operation: "doctor", configuredAgentDatabaseTargets });
const register = (agentId: string, pathname: string, schemaVersion = PREVIOUS_VERSION) =>
  registerOpenClawAgentDatabase({ agentId, path: pathname, env, schemaVersion });

function createLegacyAgentDatabase(params: { agentId?: string; path?: string } = {}): string {
  return createLegacyDatabaseFixture({
    ...params,
    env,
    eventsBySession: {},
    schemaVersion: PREVIOUS_VERSION,
  });
}

function readUserVersion(databasePath: string): number {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

function expectMigrated(databasePath: string, agentId: string) {
  expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(registrations(true)).toEqual([
    expect.objectContaining({
      agentId,
      path: databasePath,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    }),
  ]);
}

beforeEach(() => {
  stateDir = tempDir();
  env = { OPENCLAW_STATE_DIR: stateDir };
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

it.each([
  { cleanupCompleted: false, deleteFiles: false },
  { cleanupCompleted: false, deleteFiles: true },
  { cleanupCompleted: true, deleteFiles: false },
  { cleanupCompleted: true, deleteFiles: true },
])(
  "respects deletion custody while migrating active schema 24 (complete=$cleanupCompleted, deleteFiles=$deleteFiles)",
  async ({ cleanupCompleted, deleteFiles }) => {
    const deletedId = "deleted-project";
    const activeId = "active-anchor";
    const createStore = (agentId: string) => {
      openOpenClawStateDatabase({ env });
      const pathname = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      using source = new DatabaseSync(pathname);
      source.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
      source.exec("PRAGMA user_version = 24");
      source
        .prepare(
          "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES ('primary', 'agent', 24, ?, '2026.9.9', 1, 1)",
        )
        .run(agentId);
      register(agentId, pathname, 24);
      return pathname;
    };
    const activePath = createStore(activeId);
    const deletedPath = createStore(deletedId);
    beginAgentDeletionJournal(
      {
        agentId: deletedId,
        operationId: "delete-project",
        agentDir: path.dirname(deletedPath),
        workspaceDir: path.join(stateDir, "workspace-project"),
        sessionsDir: path.join(stateDir, "agents", deletedId, "sessions"),
        deleteFiles,
      },
      { env },
    );
    if (cleanupCompleted) {
      runOpenClawStateWriteTransaction(
        (database) => {
          completeAgentDeletionJournalInDatabase(database, deletedId, "delete-project");
        },
        { env },
      );
    }
    const beforeBytes = fs.readFileSync(deletedPath);
    const beforeJournal = await readAgentDeletionJournalAsync(deletedId, { env });
    expect(beforeJournal).toBeDefined();
    const result = await migrateLegacyMediaPersistence({
      env,
      configuredAgentDatabaseTargets: [{ agentId: activeId, path: activePath }],
    });
    if (cleanupCompleted) {
      if (deleteFiles) {
        expect(result.warnings).toEqual([
          `Skipped agent database migration for ${deletedPath}: Error: OpenClaw agent database is unavailable while agent ${deletedId} is deleted.`,
        ]);
        expect(result.warningDisposition).toBeUndefined();
      } else {
        expect(result.warnings).toEqual([
          expect.stringContaining(
            `Held agent ${deletedId} database ${deletedPath} (retained-by-deletion)`,
          ),
        ]);
        expect(result.warningDisposition).toBe("recoverable");
      }
      expect(fs.readFileSync(deletedPath)).toEqual(beforeBytes);
      expect(await readAgentDeletionJournalAsync(deletedId, { env })).toEqual(beforeJournal);
      expect(readUserVersion(deletedPath)).toBe(24);
    } else {
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        `Prepared agent database schema in ${deletedPath} for pending deletion recovery.`,
      );
      expect(readUserVersion(deletedPath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
      expect(fs.readFileSync(deletedPath)).not.toEqual(beforeBytes);
      const recoveredJournal = await readAgentDeletionJournalAsync(deletedId, { env });
      expect(recoveredJournal).toEqual({
        ...beforeJournal,
        operationId: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u),
      });
      expect(recoveredJournal?.operationId).not.toBe(beforeJournal?.operationId);
    }
    expect(readUserVersion(activePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(() => openOpenClawAgentDatabase({ agentId: deletedId, env, path: deletedPath })).toThrow(
      `while agent ${deletedId} is deleted`,
    );
    const runtime = readAgentDatabaseDeletionSnapshot(env, "runtime")?.retainedDeletions;
    expect(runtime?.status).toBe(cleanupCompleted && !deleteFiles ? "present" : "empty");
  },
);

it("migrates a surviving physical owner beside a retained hardlink owner", async () => {
  const deletedId = "aaa-deleted";
  const databasePath = createLegacyAgentDatabase();
  const retainedPath = path.join(stateDir, "retained.sqlite");
  fs.linkSync(databasePath, retainedPath);
  register(deletedId, retainedPath);
  beginAgentDeletionJournal(
    {
      agentId: deletedId,
      operationId: "delete-shared-owner",
      agentDir: path.dirname(retainedPath),
      workspaceDir: path.join(stateDir, "workspace"),
      sessionsDir: path.join(stateDir, "agents", deletedId, "sessions"),
      deleteFiles: false,
    },
    { env },
  );
  runOpenClawStateWriteTransaction(
    (database) => {
      completeAgentDeletionJournalInDatabase(database, deletedId, "delete-shared-owner");
    },
    { env },
  );
  await expect(ready()).rejects.toThrow(/uses schema version 16/);
  const result = await migrateLegacyMediaPersistence({ env });
  expect(result.warnings).toEqual([]);
  expect(result.notices ?? []).toEqual([]);
  expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  await expect(ready()).resolves.toBeUndefined();
});

it("refreshes registrations after committed schema upgrades", async () => {
  const agentId = "retired";
  const databasePath = path.join(stateDir, "retained", "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId, env, path: databasePath });
  closeOpenClawAgentDatabasesForTest();
  register(agentId, databasePath, OPENCLAW_AGENT_SCHEMA_VERSION - 1);
  expect(registrations()).toEqual([]);
  expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
  expectMigrated(databasePath, agentId);
});

it("resolves registered dot-dot paths through filesystem traversal", async () => {
  const symlinkTarget = path.join(stateDir, "external", "subdir");
  fs.mkdirSync(symlinkTarget, { recursive: true });
  fs.symlinkSync(symlinkTarget, path.join(stateDir, "link"), "dir");
  const filesystemPath = path.join(stateDir, "external", "x", "openclaw-agent.sqlite");
  const lexicalPath = path.join(stateDir, "x", "openclaw-agent.sqlite");
  for (const databasePath of [filesystemPath, lexicalPath]) {
    createLegacyAgentDatabase({ path: databasePath });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
  }
  const registeredPath = `${path.join(stateDir, "link")}${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`;
  expect(fs.realpathSync.native(registeredPath)).toBe(filesystemPath);
  expect(path.resolve(registeredPath)).toBe(lexicalPath);
  register("main", registeredPath);
  await expect(ready()).rejects.toThrow(/uses schema version 16/);
  expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);
  expect(readUserVersion(filesystemPath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  expect(readUserVersion(lexicalPath)).toBe(PREVIOUS_VERSION);
  await expect(ready()).resolves.toBeUndefined();
});

it.each([
  ["media-persistence", "discovery"],
  ["transcript-directives", "none"],
  ["transcript-directives", "database"],
] as const)("unregisters foreign paths without writes: %s/%s", async (owner, failure) => {
  const migrate =
    owner === "media-persistence"
      ? migrateLegacyMediaPersistence
      : migrateHistoricalTranscriptDirectives;
  const foreignStateDir = tempDir();
  const foreignPath = (directory: string) =>
    path.join(foreignStateDir, directory, "main", "agent", "openclaw-agent.sqlite");
  const databasePath = foreignPath(`agents\n${String.fromCharCode(0x1b)}[31mforged`);
  const sanitizedDatabasePath = foreignPath("agentsforged");
  createLegacyAgentDatabase({ path: databasePath });
  const beforeBytes = fs.readFileSync(databasePath);
  const beforeMtimeMs = fs.statSync(databasePath).mtimeMs;
  const ownedDatabasePath = path.join(
    stateDir,
    failure === "discovery" ? "agents" : "broken.sqlite",
  );
  if (failure !== "none") {
    fs.writeFileSync(ownedDatabasePath, "not a SQLite database");
  }
  const result = await migrate({
    env,
    configuredAgentDatabaseTargets:
      failure === "database" ? [{ agentId: "broken", path: ownedDatabasePath }] : [],
  });
  expect(result.warnings).toContain(
    `Skipped foreign agent database ${sanitizedDatabasePath}; it is outside the active state directory and is not a configured session store.`,
  );
  expect(result.warnings.join("\n")).not.toContain(databasePath);
  expect(registrations(true)).toEqual([]);
  expect(fs.readFileSync(databasePath).equals(beforeBytes)).toBe(true);
  expect(fs.statSync(databasePath).mtimeMs).toBe(beforeMtimeMs);
  const receipt = createLegacyStateMigrationStepReceipt(
    {
      id: owner,
      phase: "shared",
      source: [],
      target: [],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
    },
    result,
  );
  expect({ outcome: receipt.outcome, code: receipt.refusal?.code }).toEqual({
    outcome: failure !== "none" ? "refused" : "warning",
    code: failure !== "none" ? "step-refused" : undefined,
  });
  if (failure !== "none") {
    expect(result.warnings).toContainEqual(expect.stringContaining(ownedDatabasePath));
    expect(fs.readFileSync(ownedDatabasePath, "utf8")).toBe("not a SQLite database");
  }
});

it("prefers configured owners over stale registrations", async () => {
  const databasePath = path.join(tempDir(), "openclaw-agent.sqlite");
  createLegacyAgentDatabase({ agentId: "new", path: databasePath });
  unregisterOpenClawAgentDatabase({ agentId: "new", env, path: databasePath });
  register("old", databasePath);
  const configuredAgentDatabaseTargets = [{ agentId: "new", path: databasePath }];
  await expect(ready(configuredAgentDatabaseTargets)).rejects.toThrow(/uses schema version 16/);
  expect(registrations(true)).toEqual([
    expect.objectContaining({ agentId: "old", path: databasePath }),
  ]);
  const result = await migrateLegacyMediaPersistence({ configuredAgentDatabaseTargets, env });
  expect(result.warnings).toContain(
    `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
  );
  expectMigrated(databasePath, "new");
});

it("prunes missing and archived registrations", async () => {
  const missingPath = path.join(stateDir, "agents", "missing", "agent", "openclaw-agent.sqlite");
  const archivedPath = path.join(stateDir, "imports", "archived", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.writeFileSync(archivedPath, "archived fixture");
  const state = openOpenClawStateDatabase({ env });
  const insert = state.db.prepare(
    "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
  );
  insert.run("missing", missingPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
  insert.run("archived", archivedPath, 8, 1, null);
  await expect(ready()).resolves.toBeUndefined();
  expect(state.db.prepare("SELECT agent_id FROM agent_databases ORDER BY agent_id").all()).toEqual([
    { agent_id: "archived" },
    { agent_id: "missing" },
  ]);
  const result = await migrateLegacyMediaPersistence({ env });
  expect(result.changes).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Removed missing agent database registry entry"),
      expect.stringContaining("Removed archived or transient agent database registry entry"),
    ]),
  );
  expect(result.warnings).toContain(`Skipped missing registered agent database ${missingPath}.`);
  expect(registrations(true)).toEqual([]);
});
