import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentsRestoreManyParams } from "../../../packages/gateway-protocol/src/index.js";
import { settleAgentCreationTombstone } from "../../agents/agent-create-restoration.js";
import { validateAgentIdInput } from "../../agents/agent-create.js";
import {
  resolveAgentWorkspaceDir,
  resolveEffectiveAgentDir,
} from "../../agents/agent-scope-config.js";
import { sanitizeAgentIdentityLine } from "../../agents/identity-file.js";
import { applyAgentConfig, listAgentEntries } from "../../commands/agents.config.js";
import { transformConfigFileWithRetry, withConfigMutationExclusive } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { copyRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { resolveConfiguredAgentDatabaseTargets } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getDatabaseEngineInput } from "../../infra/database-engine/context.js";
import { sameFileMutationFingerprint } from "../../infra/file-descriptor.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { runWithAgentCreationClaim } from "../../state/agent-creation-claim.js";
import {
  readAgentDeletionJournalForCreation,
  readAgentDeletionRecoveryHoldsInWorker,
} from "../../state/agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import { createAgentSchemaInspectionWorker } from "../../state/openclaw-agent-schema-inspection-worker.js";

type RestoreAgent = AgentsRestoreManyParams["agents"][number];

export class AgentRosterRestoreError extends Error {}

export function prepareRetainedPostgresRoster(
  config: OpenClawConfig,
  request: readonly RestoreAgent[],
) {
  const ids = new Set<string>();
  const stores = new Set<string>();
  const schemas = new Set<string>();
  let nextConfig = config;
  const agents = request.map((agent) => {
    const { agentId, storeId, schema } = agent;
    const id = validateAgentIdInput(agentId);
    const name = sanitizeAgentIdentityLine(agent.name);
    const workspace = path.normalize(agent.workspace);
    const model = agent.model?.trim();
    if (
      !id.ok ||
      id.agentId !== agentId ||
      !name ||
      !path.isAbsolute(workspace) ||
      !storeId.trim() ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(schema)
    ) {
      throw new AgentRosterRestoreError(
        "Retained roster requires a canonical agent ID, name and absolute workspace.",
      );
    }
    if (ids.has(agentId) || stores.has(storeId) || schemas.has(schema)) {
      throw new AgentRosterRestoreError("Retained roster repeats an agent or PostgreSQL store.");
    }
    ids.add(agentId);
    stores.add(storeId);
    schemas.add(schema);
    const existing = listAgentEntries(config).find((entry) => entry.id === agentId);
    if (existing) {
      if (
        existing.name !== name ||
        resolveAgentWorkspaceDir(config, agentId) !== workspace ||
        (model !== undefined && resolveAgentModelPrimaryValue(existing.model) !== model)
      ) {
        throw new AgentRosterRestoreError(
          `Configured agent "${agentId}" conflicts with retained roster.`,
        );
      }
    } else {
      nextConfig = applyAgentConfig(nextConfig, {
        agentId,
        name,
        workspace,
        model,
        identity: { name },
      });
    }
    return {
      agentId,
      name,
      workspace,
      storeId,
      schema,
      agentDir: resolveEffectiveAgentDir(nextConfig, agentId),
      ...(model ? { model } : {}),
    };
  });
  return { nextConfig, agents };
}

export async function restoreRetainedPostgresRoster(params: {
  agents: readonly RestoreAgent[];
  assertCurrent: () => void;
  writeOptions: ConfigWriteOptions;
}) {
  if (!getDatabaseEngineInput("agent")) {
    throw new AgentRosterRestoreError("Retained roster restore requires PostgreSQL agent storage.");
  }
  return await withConfigMutationExclusive(async (config) => {
    const { nextConfig, agents } = prepareRetainedPostgresRoster(config, params.agents);
    const recoveryHolds = await readAgentDeletionRecoveryHoldsInWorker();
    const journal = await Promise.all(
      agents.map(({ agentId }) => readAgentDeletionJournalForCreation(agentId)),
    );
    const targets = resolveConfiguredAgentDatabaseTargets(nextConfig, {
      env: process.env,
      nativeAgentIds: new Set(agents.map(({ agentId }) => agentId)),
    });
    const workspacePaths = new Set<string>();
    const retained = agents.map((agent, index) => {
      const { agentDir, agentId, workspace } = agent;
      if (recoveryHolds.some((entry) => entry.agentId === agentId)) {
        throw new AgentRosterRestoreError(`Agent "${agentId}" requires held database recovery.`);
      }
      const workspacePath = realpathSync(workspace);
      if (!statSync(workspacePath).isDirectory() || workspacePaths.has(workspacePath)) {
        throw new AgentRosterRestoreError(
          `Agent "${agentId}" requires its own restored workspace.`,
        );
      }
      workspacePaths.add(workspacePath);
      const pathname = path.join(agentDir, "openclaw-agent.sqlite");
      const canonical = realpathSync(pathname);
      const fingerprint = lstatSync(pathname, { bigint: true });
      if (
        !fingerprint.isFile() ||
        targets.some(
          (target) =>
            target.agentId === agentId && !isSameOpenClawAgentDatabasePath(target.path, pathname),
        )
      ) {
        throw new AgentRosterRestoreError(
          `Agent "${agentId}" requires its canonical retained database.`,
        );
      }
      const deletion = journal[index];
      const databaseFiles = new Set(resolveSqliteDatabaseFilePaths(pathname));
      if (
        deletion &&
        (!deletion.cleanupCompleted ||
          deletion.deleteFiles ||
          path.normalize(deletion.agentDir) !== path.normalize(agentDir) ||
          path.normalize(deletion.workspaceDir) !== workspace ||
          deletion.databasePaths.some((location) => !databaseFiles.has(path.resolve(location))))
      ) {
        throw new AgentRosterRestoreError(`Agent "${agentId}" has incompatible deletion custody.`);
      }
      return { agent, deletion, pathname, fingerprint, canonical };
    });
    const assertCurrent = () => {
      params.assertCurrent();
      for (const { agent, pathname, fingerprint, canonical } of retained) {
        if (
          realpathSync(pathname) !== canonical ||
          !sameFileMutationFingerprint(fingerprint, lstatSync(pathname, { bigint: true }))
        ) {
          throw new AgentRosterRestoreError(
            `Agent "${agent.agentId}" retained anchor changed before publication.`,
          );
        }
      }
    };
    {
      await using inspector = createAgentSchemaInspectionWorker();
      for (const { agent, pathname } of retained) {
        assertCurrent();
        const inspection = await inspector.inspect({
          pathname,
          agentId: agent.agentId,
          env: process.env,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          inspectOwnership: true,
          expectedPostgresIdentity: { storeId: agent.storeId, namespace: agent.schema },
        });
        if (
          !inspection ||
          inspection.failure ||
          inspection.reason ||
          inspection.version !== OPENCLAW_AGENT_SCHEMA_VERSION ||
          inspection.agentSchemaMeta?.agentId !== agent.agentId ||
          inspection.agentSchemaMeta.role !== "agent" ||
          inspection.agentSchemaMeta.schemaVersion !== inspection.version
        ) {
          throw new AgentRosterRestoreError(
            `Agent "${agent.agentId}" does not own a current retained PostgreSQL store.`,
          );
        }
      }
    }
    assertCurrent();
    const published = nextConfig !== config;
    if (published) {
      const agentIds = retained.flatMap(({ agent, deletion }) => (deletion ? [agent.agentId] : []));
      await runWithAgentCreationClaim({ agentIds }, async (settle) => {
        const writeOptions = copyRuntimeConfigWriteApplication(params.writeOptions, {
          ...params.writeOptions,
          assertConfigPathForWrite: assertCurrent,
          beforeCommit: async () => {
            assertCurrent();
            await params.writeOptions.beforeCommit?.();
            await settle();
          },
        });
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          maxAttempts: 1,
          writeOptions,
          transform: (current) => {
            if (!isDeepStrictEqual(current, config)) {
              throw new AgentRosterRestoreError(
                "Configuration changed during retained roster admission.",
              );
            }
            return { nextConfig };
          },
        });
      });
    }
    // Completed retain-only tombstones are settled after the roster commit, as in
    // single-agent restoration. Exact replay resumes settlement without a new write.
    for (const { deletion } of retained) {
      await settleAgentCreationTombstone(deletion);
    }
    return { agents, published };
  });
}
