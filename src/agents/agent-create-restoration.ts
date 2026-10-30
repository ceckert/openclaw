import { statSync } from "node:fs";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../commands/agents.config.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runWithAgentCreationClaim } from "../state/agent-creation-claim.js";
import type {
  AgentDeletionJournalEntry,
  HeldAgentDatabase,
} from "../state/agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createAgentSchemaInspectionWorker } from "../state/openclaw-agent-schema-inspection-worker.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { normalizeAgentDirRegistryPath } from "./agent-dir-registry.js";
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
  const retainedTargets: { agentId: string; path: string }[] = [];
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
      retainedTargets.push(target);
    }
  }
  // A creation claim admits this identity beneath its completed tombstone. Existing-only
  // admission cannot replace missing stores; claim close must settle before journal claim.
  await runWithAgentCreationClaim({ agentId }, async () => {
    for (const target of retainedTargets) {
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

export function selectedRecoveryPaths(
  config: OpenClawConfig,
  agentId: string,
  held: readonly HeldAgentDatabase[],
  samePath: ReturnType<typeof createOpenClawAgentDatabasePathMatcher>,
  explicitAgentDir?: string,
): string[] {
  if (!held.some((entry) => entry.agentId === agentId)) {
    return [];
  }
  const currentDir = resolveAgentDir(config, agentId);
  const changedDir =
    explicitAgentDir !== undefined &&
    normalizeAgentDirRegistryPath(explicitAgentDir) !== normalizeAgentDirRegistryPath(currentDir);
  if (changedDir && findAgentEntryIndex(listAgentEntries(config), agentId) >= 0) {
    return [];
  }
  const selectedDir = explicitAgentDir ?? currentDir;
  const targets = resolveConfiguredAgentDatabaseTargets(
    applyAgentConfig(config, { agentId, agentDir: selectedDir }),
    { env: process.env, registeredDatabases: held },
  );
  return held
    .filter(
      (entry) =>
        entry.agentId === agentId &&
        statSync(entry.path, { throwIfNoEntry: false })?.isFile() &&
        targets.some((target) => target.agentId === agentId && samePath(target.path, entry.path)),
    )
    .map((entry) => entry.path);
}
