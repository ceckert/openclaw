import { createAgent } from "../../agents/agent-create.js";
import { hasAgentRosterProperty, tryResolveSoleAgentId } from "../../agents/agent-roster.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
  pruneAgentConfig,
} from "../../commands/agents.config.js";
import { mutateConfigFileWithRetry, transformConfigFileWithRetry } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { copyRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions.js";
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type AgentDeleteMutationResult = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
  removedBindings: number;
};

export class AgentConfigPreconditionError extends Error {}

export class AgentModelSelectionError extends Error {}

type AgentConfigUpdate = Omit<Parameters<typeof applyAgentConfig>[1], "agentDir"> & {
  agentRuntime?: string;
};

function isModelOnlyUpdate(params: AgentConfigUpdate): boolean {
  return (
    Boolean(params.model) &&
    params.name === undefined &&
    params.workspace === undefined &&
    params.identity === undefined
  );
}

export function validateAgentModelSelectionUpdate(
  params: AgentConfigUpdate & { emoji?: string; avatar?: string },
): string | undefined {
  if (!params.agentRuntime) {
    return undefined;
  }
  if (
    !isModelOnlyUpdate(params) ||
    params.emoji !== undefined ||
    params.avatar !== undefined ||
    !params.model
  ) {
    return "Runtime selection requires a model-only update.";
  }
  if (splitTrailingAuthProfile(params.model).profile) {
    return "Choose a model without an OpenClaw sign-in override for this runtime.";
  }
  return undefined;
}

export function isConfiguredAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

export function isImplicitAgentModelUpdate(
  cfg: OpenClawConfig,
  params: AgentConfigUpdate,
): boolean {
  return (
    !hasAgentRosterProperty(cfg) &&
    tryResolveSoleAgentId(cfg) === params.agentId &&
    isModelOnlyUpdate(params) &&
    params.agentRuntime !== undefined
  );
}

export function createAgentConfigEntry(
  params: Omit<Parameters<typeof createAgent>[0], "transformConfig">,
  writeOptions?: ConfigWriteOptions,
) {
  return createAgent({
    ...params,
    transformConfig: (mutation) =>
      transformConfigFileWithRetry({
        ...mutation,
        writeOptions: copyRuntimeConfigWriteApplication(writeOptions, mutation.writeOptions ?? {}),
      }),
  });
}

export async function updateAgentConfigEntry(
  params: AgentConfigUpdate & { assertCurrent?: () => void },
  writeOptions?: ConfigWriteOptions,
): Promise<void> {
  const selectionModules = params.agentRuntime
    ? await Promise.all([
        import("../../agents/model-runtime-choice.js"),
        import("../../commands/models/shared.js"),
        import("../../system-agent/setup-model-selection.js"),
      ])
    : undefined;
  let validateSelection: (() => string | undefined) | undefined;
  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    // Identity replacement may intentionally reduce the configuration size.
    writeOptions: copyRuntimeConfigWriteApplication(writeOptions, {
      ...(params.identity ? { allowConfigSizeDrop: true } : {}),
      assertConfigPathForWrite: () => {
        params.assertCurrent?.();
        const error = validateSelection?.();
        if (error) {
          throw new AgentModelSelectionError(error);
        }
      },
    }),
    mutate: async (draft) => {
      validateSelection = undefined;
      const configured = isConfiguredAgent(draft, params.agentId);
      if (!configured && !isImplicitAgentModelUpdate(draft, params)) {
        throw new AgentConfigPreconditionError(`agent "${params.agentId}" not found`);
      }
      let next = draft;
      if (params.model && selectionModules) {
        const [runtimeChoice, modelConfig, modelSelection] = selectionModules;
        const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: draft });
        const choice = await runtimeChoice.preparePublishedModelRuntimeChoice({
          cfg: draft,
          agentId: params.agentId,
          provider: target.provider,
          model: target.model,
          runtimeId: params.agentRuntime,
        });
        if (choice.kind === "unavailable") {
          throw new AgentModelSelectionError(choice.message);
        }
        validateSelection = choice.validate;
        next = await modelSelection.applySystemAgentModelSelection({
          config: draft,
          model: params.model,
          agentRuntimeId: choice.runtimeId,
          ...(configured ? { targetAgentId: params.agentId } : { runtimeInDefaults: true }),
        });
      }
      const latestNextConfig = configured
        ? applyAgentConfig(next, {
            agentId: params.agentId,
            ...(params.name ? { name: params.name } : {}),
            ...(params.workspace ? { workspace: params.workspace } : {}),
            ...(!params.agentRuntime && params.model !== undefined ? { model: params.model } : {}),
            ...(params.identity ? { identity: params.identity } : {}),
          })
        : next;
      Object.assign(draft, latestNextConfig);
    },
  });
}

/** Removes an agent entry and returns filesystem roots the caller should clean up. */
type AgentConfigRemoval = {
  agentId: string;
  validate?: (agent: AgentConfig) => void;
  allowMissing?: boolean;
};

type AgentConfigRemovalOptions = {
  assertCurrent?: () => void;
  assertCurrentAsync?: () => Promise<void>;
  writeOptions?: ConfigWriteOptions;
};

export async function deleteAgentConfigEntry(
  params: AgentConfigRemoval & AgentConfigRemovalOptions,
) {
  const committed = await deleteAgentConfigEntries([params], params);
  return { nextConfig: committed.nextConfig, result: committed.result.get(params.agentId) };
}

export async function deleteAgentConfigEntries(
  removals: readonly AgentConfigRemoval[],
  options: AgentConfigRemovalOptions,
) {
  return await mutateConfigFileWithRetry<Map<string, AgentDeleteMutationResult>>({
    afterWrite: { mode: "auto" },
    writeOptions: copyRuntimeConfigWriteApplication(options.writeOptions, {
      allowedAgentRosterRemovals: removals.map(({ agentId }) => agentId),
      assertConfigPathForWrite: options.assertCurrent,
      beforeCommit: options.assertCurrentAsync,
      allowConfigSizeDrop: true,
    }),
    mutate: (draft) => {
      options.assertCurrent?.();
      const removed = new Map<string, AgentDeleteMutationResult>();
      for (const { agentId, allowMissing, validate } of removals) {
        const agent = listAgentEntries(draft).find((candidate) => candidate.id === agentId);
        if (!agent && !allowMissing) {
          throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
        }
        const result = pruneAgentConfig(draft, agentId);
        if (agent) {
          validate?.(agent);
          removed.set(agentId, {
            workspaceDir: resolveAgentWorkspaceDir(draft, agentId),
            agentDir: resolveAgentDir(draft, agentId),
            sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
            removedBindings: result.removedBindings,
          });
        }
        Object.assign(draft, result.config);
      }
      return removed;
    },
  });
}
