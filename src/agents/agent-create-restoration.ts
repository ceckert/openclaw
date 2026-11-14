import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runWithAgentCreationClaim } from "../state/agent-creation-claim.js";
import type { AgentDeletionJournalEntry } from "../state/agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createAgentSchemaInspectionWorker } from "../state/openclaw-agent-schema-inspection-worker.js";
import { resolveUserPath } from "../utils.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { migrateRetainedAgentStores } from "./agent-create-retained-stores.js";
import { normalizeAgentDirRegistryPath } from "./agent-dir-registry.js";
import { claimCompletedAgentDeletion } from "./agent-lifecycle-registry.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";

/** Admit the canonical retained stores before creation settles a completed deletion. */
export async function admitConfiguredAgentRestoration(params: {
  config: OpenClawConfig;
  agentId: string;
  deletion: AgentDeletionJournalEntry;
  explicitAgentDir?: string;
  explicitWorkspace?: string;
  matchesDatabasePath: (left: string, right: string) => boolean;
  assertCurrent: () => void;
}): Promise<void> {
  const { config, agentId, deletion, explicitAgentDir, explicitWorkspace, assertCurrent } = params;
  const agentDir = resolveAgentDir(config, agentId);
  const workspace = resolveAgentWorkspaceDir(config, agentId);
  const samePath = (left: string, right: string) =>
    normalizeAgentDirRegistryPath(left) === normalizeAgentDirRegistryPath(right);
  if (
    (explicitAgentDir && !samePath(explicitAgentDir, agentDir)) ||
    (explicitWorkspace && !samePath(explicitWorkspace, workspace)) ||
    !samePath(deletion.agentDir, agentDir) ||
    !samePath(deletion.workspaceDir, workspace)
  ) {
    throw new DuplicateAgentError(
      `Agent ${agentId} restoration requires its original configured workspace and agentDir.`,
    );
  }
  const targets = resolveConfiguredAgentDatabaseTargets(config, {
    env: process.env,
    agentId,
    registeredDatabases: deletion.databasePaths.map((path) => ({ agentId, path })),
  });
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        !deletion.databasePaths.some((path) => params.matchesDatabasePath(target.path, path)),
    ) ||
    deletion.databasePaths.some(
      (path) =>
        !targets.some(
          (target) =>
            params.matchesDatabasePath(target.path, path) ||
            resolveSqliteDatabaseFilePaths(target.path).some((file) => samePath(file, path)),
        ),
    )
  ) {
    throw new DuplicateAgentError(
      `Agent ${agentId} restoration requires its original configured databases.`,
    );
  }
  await admitRetainedAgentStores({ targets, agentId, assertCurrent });
}

async function admitRetainedAgentStores(params: {
  targets: readonly { agentId: string; path: string }[];
  agentId: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { targets, agentId, assertCurrent } = params;
  const pendingMigrations: string[] = [];
  // Existing physical files can still lack their logical store (including a lost PG
  // namespace). Inspect every retained store before any writer may initialize it.
  {
    await using inspector = createAgentSchemaInspectionWorker();
    for (const target of targets) {
      assertCurrent();
      const inspection = await inspector.inspect({
        pathname: target.path,
        agentId,
        env: process.env,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        verifyCurrentSchemaShape: true,
        inspectOwnership: true,
      });
      assertCurrent();
      if (inspection?.failure) {
        throw inspection.failure;
      }
      if (inspection?.reason) {
        throw new Error(inspection.reason);
      }
      if (
        !inspection ||
        inspection.version <= 0 ||
        inspection.version > OPENCLAW_AGENT_SCHEMA_VERSION ||
        inspection.agentSchemaMeta?.agentId !== agentId ||
        inspection.agentSchemaMeta.role !== "agent" ||
        inspection.agentSchemaMeta.schemaVersion !== inspection.version
      ) {
        throw new DuplicateAgentError(
          `Agent ${agentId} preserved database is uninitialized; restore it before rerunning agents add.`,
        );
      }
      if (inspection.version < OPENCLAW_AGENT_SCHEMA_VERSION) {
        pendingMigrations.push(target.path);
      }
    }
  }
  await migrateRetainedAgentStores({
    agentId,
    paths: pendingMigrations,
    allowRestore: true,
    assertCurrent,
  });
  // A creation claim admits this identity beneath its completed tombstone. Existing-only
  // admission cannot replace missing stores; claim close must settle before journal claim.
  await runWithAgentCreationClaim({ agentId }, async () => {
    for (const target of targets) {
      assertCurrent();
      const execution = captureOpenClawAgentDatabaseExecution(target);
      try {
        const admitted = await execution.runExisting(
          createSessionWorkerExecutionSource(
            assertCurrent,
            `Agent ${agentId} restoration admission expired`,
          ),
          async () => true,
        );
        if (admitted !== true) {
          throw new DuplicateAgentError(
            `Agent ${agentId} preserved database is missing; restore it before rerunning agents add.`,
          );
        }
      } finally {
        await execution.release();
      }
    }
  });
  assertCurrent();
}

export function bindAgentCreationStoreMigration(params: {
  agentId: string;
  recoveryPaths: readonly string[];
  deletion: AgentDeletionJournalEntry | undefined;
  automaticBootstrap: boolean;
  assertCurrent: () => void;
}) {
  const { recoveryPaths, agentId, deletion, automaticBootstrap, assertCurrent } = params;
  return async (config: OpenClawConfig): Promise<void> => {
    if (recoveryPaths.length === 0 && deletion?.deleteFiles !== false) {
      return;
    }
    const paths =
      recoveryPaths.length > 0
        ? recoveryPaths
        : resolveConfiguredAgentDatabaseTargets(config, { env: process.env, agentId }).map(
            (target) => target.path,
          );
    await migrateRetainedAgentStores({
      agentId,
      paths,
      allowRestore: !automaticBootstrap,
      assertCurrent,
    });
  };
}

export async function settleAgentCreationTombstone(
  deletion: AgentDeletionJournalEntry,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  if (!(await claimCompletedAgentDeletion(deletion.agentId, deletion.operationId))) {
    throw new Error(`agent "${deletion.agentId}" deletion tombstone changed during creation`);
  }
}

export function resolveOptionalAgentCreationPath(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed ? resolveUserPath(trimmed) : undefined;
}
