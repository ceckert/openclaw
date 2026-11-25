import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAgentSessionStoreDeletionSafe,
  drainAgentDeleteDatabaseWork,
  isPathOwnedBySurvivingAgent,
  prepareAgentDeleteDatabases,
  prepareJournaledAgentDirOwnership,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
} from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
  isSharedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import {
  AgentDeletionAuthorityRollbackError,
  claimCompletedAgentDeletion,
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../../agents/agent-lifecycle-registry.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveSoleAgentId,
} from "../../agents/agent-scope.js";
import {
  prepareSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import { withConfigMutationExclusive } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readBackupEngine } from "../../infra/database-engine/physical-store.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { AgentDeletionPendingError } from "../../sessions/session-agent-work-admission-error.js";
import { closeAgentWorkAdmissions } from "../../sessions/session-controller.lifecycle.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { AgentConfigPreconditionError, isConfiguredAgent } from "./agents-config-mutations.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import type { GatewayRequestContext } from "./types.js";

export class AgentSharedAuthStoreOwnerError extends Error {}

async function agentOwnsSharedAuthStore(cfg: OpenClawConfig, agentId: string): Promise<boolean> {
  await prepareSharedAuthStoreOwnership();
  const agentDir = resolveAgentDir(cfg, agentId);
  return isSharedAuthStoreOwner({
    ownership: resolveSharedAuthStoreOwnership(),
    agentAuthDbPath: resolveAuthProfileDatabasePath(agentDir),
    sharedAuthDbPath: resolveSharedAuthStorePath(),
  });
}

export type AgentRemovalOptions = {
  recoveryOperationId?: string;
  writeOptions?: ConfigWriteOptions;
  detach?: boolean;
};

export type PreparedAgentRemoval = {
  deletion: AgentDeletionOperation;
  existing: boolean;
};

async function closeOrphanedPostgresAnchor(
  cfg: OpenClawConfig,
  agentId: string,
  context: GatewayRequestContext,
): Promise<void> {
  if (isConfiguredAgent(context.getRuntimeConfig(), agentId)) {
    return;
  }
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId });
  let realDatabasePath: string;
  try {
    realDatabasePath = await fs.realpath(databasePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const stateDir = resolveStateDir();
  const canonicalDatabasePath = path.resolve(
    await fs.realpath(stateDir),
    path.relative(stateDir, databasePath),
  );
  const anchor = await fs.lstat(databasePath);
  if (
    realDatabasePath !== canonicalDatabasePath ||
    !anchor.isFile() ||
    anchor.nlink !== 1 ||
    readBackupEngine(databasePath).engine !== "postgres"
  ) {
    return;
  }
  const registered = await readAgentDeleteDatabaseRegistry();
  if (
    isPathOwnedBySurvivingAgent(
      cfg,
      agentId,
      databasePath,
      resolveSurvivingDatabaseFilePaths(registered, agentId),
    )
  ) {
    return;
  }
  const current = await fs.lstat(databasePath);
  if (
    current.dev !== anchor.dev ||
    current.ino !== anchor.ino ||
    isConfiguredAgent(context.getRuntimeConfig(), agentId)
  ) {
    return;
  }
  const { closeOpenClawAgentDatabaseByPathAsync } =
    await import("../../state/openclaw-agent-db-lifecycle.js");
  const { closeAgentDatabaseReaders } = await import("../../state/openclaw-agent-db-readers.js");
  await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
  await closeAgentDatabaseReaders([databasePath]);
}

export async function withPreparedAgentRemoval<T>(
  agentId: string,
  requestedDeleteFiles: boolean,
  context: GatewayRequestContext,
  options: AgentRemovalOptions,
  run: (prepared: PreparedAgentRemoval) => Promise<T>,
): Promise<T> {
  const { recoveryOperationId } = options;
  let releaseIngress: (() => void) | undefined;
  try {
    return await withAgentDeletion(agentId, async (begin) => {
      const prepared = await withConfigMutationExclusive(async (lockedConfig) => {
        await assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
        let lockedJournal = await readAgentDeletionJournalAsync(agentId);
        if (
          recoveryOperationId &&
          (lockedJournal?.operationId !== recoveryOperationId || lockedJournal.cleanupCompleted)
        ) {
          throw new Error(`Agent ${agentId} deletion recovery no longer owns its journal.`);
        }
        const configured = isConfiguredAgent(lockedConfig, agentId);
        if (await agentOwnsSharedAuthStore(lockedConfig, agentId)) {
          throw new AgentSharedAuthStoreOwnerError(formatSharedAuthStoreOwnerDeleteError(agentId));
        }
        if (!configured && (!lockedJournal || lockedJournal.cleanupCompleted)) {
          if (options.detach && !recoveryOperationId) {
            await closeOrphanedPostgresAnchor(lockedConfig, agentId, context);
          }
          throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
        }
        if (agentId === tryResolveSoleAgentId(lockedConfig)) {
          throw new AgentConfigPreconditionError(
            `Agent "${agentId}" is the only configured agent and cannot be deleted.`,
          );
        }
        if (isInheritedAuthStoreOwner(lockedConfig, agentId)) {
          throw new AgentConfigPreconditionError(
            `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.`,
          );
        }
        if (configured && lockedJournal?.cleanupCompleted) {
          const claimed = await claimCompletedAgentDeletion(agentId, lockedJournal.operationId);
          const remainingJournal = await readAgentDeletionJournalAsync(agentId);
          if (!claimed && remainingJournal) {
            throw new Error(`agent "${agentId}" deletion tombstone changed before fresh deletion`);
          }
          lockedJournal = undefined;
        }
        if (
          options.detach &&
          lockedJournal &&
          lockedJournal.phase !== "detach-draining" &&
          lockedJournal.phase !== "detach-retiring"
        ) {
          throw new AgentConfigPreconditionError(
            `Agent "${agentId}" has a pending deletion; finish agents.delete before detaching.`,
          );
        }
        const detach = lockedJournal
          ? lockedJournal.phase === "detach-draining" || lockedJournal.phase === "detach-retiring"
          : options.detach === true;
        const deleteFiles = detach ? false : (lockedJournal?.deleteFiles ?? requestedDeleteFiles);
        releaseIngress = closeAgentWorkAdmissions({
          agentId,
          reason: new AgentDeletionPendingError(
            `Agent ${agentId} deletion is draining active work.`,
          ),
        });
        const deletion = await begin(
          lockedJournal ?? {
            agentId,
            agentDir: resolveAgentDir(lockedConfig, agentId),
            workspaceDir: resolveAgentWorkspaceDir(lockedConfig, agentId),
            sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
            deleteFiles,
            phase: detach ? "detach-draining" : "draining",
          },
          { recoveryOperationId },
        );
        options.recoveryOperationId = deletion.entry.operationId;
        return { deletion, lockedJournal, config: lockedConfig };
      });
      const { deletion, lockedJournal } = prepared;
      const journal = deletion.entry;
      if (journal.phase === "draining" || journal.phase === "detach-draining") {
        await drainAgentDeletionRuns(
          agentId,
          prepared.config,
          context,
          deletion.assertCurrentFinal,
        );
      }
      const { closeActiveMemorySearchManagerCore } =
        await import("../../plugins/memory-runtime.js");
      await deletion.assertCurrentAsync();
      await closeActiveMemorySearchManagerCore({ cfg: prepared.config, agentId });
      await deletion.assertCurrentAsync();
      if (journal.phase === "draining" || journal.phase === "detach-draining") {
        await drainAgentDeleteDatabaseWork(deletion);
        try {
          await deletion.retire();
        } catch (error) {
          if (error instanceof AgentDeletionPendingError && journal.phase === "detach-draining") {
            try {
              await withConfigMutationExclusive(async (lockedConfig) => {
                await deletion.assertCurrentAsync();
                const current = await deletion.runWithWorker((scope) =>
                  scope.execute({ type: "agentDeletion.read", input: { agentId } }),
                );
                if (
                  current?.operationId === journal.operationId &&
                  current.phase === "detach-draining" &&
                  !current.cleanupCompleted &&
                  !current.deleteFiles &&
                  current.cleanupPaths.every((cleanupPath) => !cleanupPath.done) &&
                  isConfiguredAgent(lockedConfig, agentId) &&
                  path.resolve(resolveAgentDir(lockedConfig, agentId)) ===
                    path.resolve(current.agentDir) &&
                  path.resolve(resolveAgentWorkspaceDir(lockedConfig, agentId)) ===
                    path.resolve(current.workspaceDir)
                ) {
                  // Replay retained terminal writes before reopening the original agent.
                  await deletion.rollback();
                }
              });
            } catch (rollbackError) {
              throw new AgentDeletionAuthorityRollbackError(
                [error, rollbackError],
                `Agent ${agentId} outbound delivery refusal could not release its detach fence.`,
              );
            }
          }
          throw error;
        }
      } else if (journal.phase === "detach-retiring") {
        // A resumed old journal must also prove custody before removing the roster.
        await deletion.retire();
      }
      return await run({ deletion, existing: lockedJournal !== undefined });
    });
  } finally {
    releaseIngress?.();
  }
}

export async function prepareAgentRemovalDatabasePlan(
  lockedConfig: OpenClawConfig,
  deletion: AgentDeletionOperation,
) {
  const journal = deletion.entry;
  const { agentId } = journal;
  await deletion.assertCurrentAsync();
  await assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
  if (
    (await agentOwnsSharedAuthStore(lockedConfig, agentId)) ||
    isInheritedAuthStoreOwner(lockedConfig, agentId)
  ) {
    throw new AgentSharedAuthStoreOwnerError(formatSharedAuthStoreOwnerDeleteError(agentId));
  }
  if (agentId === tryResolveSoleAgentId(lockedConfig)) {
    throw new AgentConfigPreconditionError(
      `Agent "${agentId}" is the only configured agent and cannot be deleted.`,
    );
  }
  prepareJournaledAgentDirOwnership(lockedConfig, agentId, journal.agentDir);
  const databasePlan = await prepareAgentDeleteDatabases(
    lockedConfig,
    agentId,
    journal.agentDir,
    {},
    deletion,
  );
  await deletion.assertCurrentAsync();
  await deletion.fenceDatabasePaths([...journal.databasePaths, ...databasePlan.fileGroups.flat()]);
  return databasePlan;
}
