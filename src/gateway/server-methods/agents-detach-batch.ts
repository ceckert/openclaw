import path from "node:path";
import type { AgentsDeleteResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  finishAgentDeleteDatabases,
  retireAgentDeleteRuntime,
} from "../../agents/agent-delete-databases.js";
import { normalizeAgentDirRegistryPath } from "../../agents/agent-dir-registry.js";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  type AgentDeletionOperation,
} from "../../agents/agent-lifecycle-registry.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import {
  readConfigFileSnapshotForWrite,
  withConfigMutationExclusive,
} from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { withAgentExecApprovalsRemoved } from "../../infra/exec-approvals.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntries,
  isConfiguredAgent,
} from "./agents-config-mutations.js";
import {
  prepareAgentRemovalDatabasePlan,
  withPreparedAgentRemoval,
  type PreparedAgentRemoval,
} from "./agents-removal-prepare.js";
import type { GatewayRequestContext } from "./types.js";

export async function detachGatewayAgents(
  agentIds: readonly string[],
  context: GatewayRequestContext,
  writeOptions?: ConfigWriteOptions,
): Promise<{ results: AgentsDeleteResult[]; configWritten: boolean }> {
  const ordered = [...new Set(agentIds)].toSorted();
  const prepared: PreparedAgentRemoval[] = [];
  const results = new Map<string, AgentsDeleteResult>();
  let rosterMayBeCommitted = false;

  async function commit() {
    if (prepared.length === 0) {
      return;
    }
    await withConfigMutationExclusive(async (lockedConfig) => {
      const deleting = new Set(prepared.map(({ deletion }) => deletion.entry.agentId));
      if (listAgentIds(lockedConfig).every((agentId) => deleting.has(agentId))) {
        throw new AgentConfigPreconditionError(
          "Detaching these agents would remove the entire roster.",
        );
      }
      const plans: Array<{
        deletion: AgentDeletionOperation;
        plan: Awaited<ReturnType<typeof prepareAgentRemovalDatabasePlan>>;
      }> = [];
      for (const { deletion } of prepared) {
        const plan = await prepareAgentRemovalDatabasePlan(lockedConfig, deletion);
        plans.push({ deletion, plan });
      }
      const removals = plans.map(({ deletion }) => ({
        agentId: deletion.entry.agentId,
        allowMissing: !isConfiguredAgent(lockedConfig, deletion.entry.agentId),
      }));
      const assertCurrent = () => {
        for (const { deletion } of plans) {
          deletion.assertCurrentFinal();
        }
      };
      const assertCurrentAsync = async () => {
        for (const { deletion } of plans) {
          await deletion.assertCurrentAsync();
        }
      };
      async function removeApprovals(
        index: number,
      ): Promise<Awaited<ReturnType<typeof deleteAgentConfigEntries>>> {
        const owner = plans[index]?.deletion;
        if (owner) {
          return await withAgentExecApprovalsRemoved(
            owner.entry.agentId,
            () => removeApprovals(index + 1),
            owner,
          );
        }
        try {
          const write = await deleteAgentConfigEntries(removals, {
            writeOptions,
            assertCurrent,
            assertCurrentAsync,
          });
          rosterMayBeCommitted = true;
          return write;
        } catch (error) {
          rosterMayBeCommitted = true;
          try {
            const persisted = await readConfigFileSnapshotForWrite();
            rosterMayBeCommitted = removals.some(
              ({ agentId, allowMissing }) =>
                !allowMissing && !isConfiguredAgent(persisted.snapshot.sourceConfig, agentId),
            );
          } catch {
            throw new AgentDeletionCommitUncertainError(error);
          }
          if (rosterMayBeCommitted) {
            throw new AgentDeletionCommitUncertainError(error);
          }
          throw error;
        }
      }
      const { result } = await removeApprovals(0);
      const { closeDeletedAgentDatabases } =
        await import("../../state/openclaw-agent-db-readers.js");
      for (const { deletion, plan } of plans) {
        const { agentDir, agentId } = deletion.entry;
        await retireAgentDeleteRuntime(deletion, plan.agentDirs);
        await closeDeletedAgentDatabases(agentId, plan.readerPaths, deletion);
        await finishAgentDeleteDatabases({
          deletion,
          agentDir: normalizeAgentDirRegistryPath(agentDir),
          deleteFiles: false,
          complete: true,
        });
        results.set(agentId, {
          ok: true,
          agentId,
          removedBindings: result?.get(agentId)?.removedBindings ?? 0,
          removed: [],
          failed: [],
        });
      }
    });
  }

  async function acquire(index: number): Promise<void> {
    const agentId = ordered[index];
    if (!agentId) {
      return commit();
    }
    let entered = false;
    try {
      await withPreparedAgentRemoval(agentId, false, context, { detach: true }, async (agent) => {
        entered = true;
        prepared.push(agent);
        try {
          await acquire(index + 1);
        } catch (error) {
          if (
            !agent.existing &&
            !rosterMayBeCommitted &&
            !(error instanceof AgentDeletionAuthorityRollbackError)
          ) {
            try {
              await withConfigMutationExclusive(async (config) => {
                const { agentDir, workspaceDir } = agent.deletion.entry;
                if (
                  isConfiguredAgent(config, agentId) &&
                  path.resolve(resolveAgentDir(config, agentId)) === path.resolve(agentDir) &&
                  path.resolve(resolveAgentWorkspaceDir(config, agentId)) ===
                    path.resolve(workspaceDir)
                ) {
                  await agent.deletion.rollback();
                }
              });
            } catch (rollbackError) {
              throw new AgentDeletionAuthorityRollbackError(
                [error, rollbackError],
                `Agent ${agentId} could not release its detach fence after batch failure.`,
              );
            }
          }
          throw error;
        }
      });
    } catch (error) {
      if (
        entered ||
        !(error instanceof AgentConfigPreconditionError) ||
        error.message !== `agent "${agentId}" not found`
      ) {
        throw error;
      }
      results.set(agentId, { ok: true, agentId, removedBindings: 0, removed: [], failed: [] });
      await acquire(index + 1);
    }
  }

  await acquire(0);
  return {
    results: agentIds.map((agentId) => results.get(agentId)!),
    configWritten: rosterMayBeCommitted,
  };
}
