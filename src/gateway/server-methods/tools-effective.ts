import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logDebug, logWarn } from "../../logger.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../protocol/index.js";
import {
  deliveryContextFromSession,
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  listAgentIds,
  loadSessionEntry,
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveAllAgentSessionStoreTargetsSync,
  resolveEffectiveToolInventory,
  resolveReplyToMode,
  resolveRuntimeConfigCacheKey,
  resolveSessionAgentId,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const TOOLS_EFFECTIVE_FRESH_TTL_MS = 10_000;
const TOOLS_EFFECTIVE_STALE_TTL_MS = 120_000;
const TOOLS_EFFECTIVE_SLOW_LOG_MS = 250;
const TOOLS_EFFECTIVE_CACHE_LIMIT = 128;
const TOOLS_EFFECTIVE_REFRESH_FALLBACK_MS = 100;
const TOOLS_EFFECTIVE_STARTUP_PREWARM_SESSION_LIMIT = 8;

let nowForToolsEffectiveCache = () => Date.now();
let toolsEffectiveRefreshFallbackMs = TOOLS_EFFECTIVE_REFRESH_FALLBACK_MS;
let scheduleToolsEffectiveImmediate = (callback: () => void): (() => void) => {
  const handle = setImmediate(callback);
  return () => clearImmediate(handle);
};
let scheduleToolsEffectiveFallbackTimeout = (
  callback: () => void,
  delayMs: number,
): (() => void) => {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return () => clearTimeout(handle);
};

type TrustedToolsEffectiveContext = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  senderIsOwner: boolean;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
};

type ToolsEffectiveCacheEntry = {
  value: EffectiveToolInventoryResult;
  createdAtMs: number;
};

const toolsEffectiveCache = new Map<string, ToolsEffectiveCacheEntry>();
const toolsEffectiveInflight = new Map<string, Promise<EffectiveToolInventoryResult>>();

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: OpenClawConfig;
  respond: RespondFn;
}) {
  const knownAgents = listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  if (!requestedAgentId) {
    return undefined;
  }
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

function optionalCacheString(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function buildToolsEffectiveCacheKey(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): string {
  const context = params.context;
  return JSON.stringify({
    v: 1,
    config: resolveRuntimeConfigCacheKey(context.cfg),
    pluginRegistry: getActivePluginRegistryVersion(),
    channelRegistry: getActivePluginChannelRegistryVersion(),
    sessionKey: params.sessionKey,
    agentId: context.agentId,
    senderIsOwner: context.senderIsOwner,
    modelProvider: optionalCacheString(context.modelProvider),
    modelId: optionalCacheString(context.modelId),
    messageProvider: optionalCacheString(context.messageProvider),
    accountId: optionalCacheString(context.accountId),
    currentChannelId: optionalCacheString(context.currentChannelId),
    currentThreadTs: optionalCacheString(context.currentThreadTs),
    groupId: optionalCacheString(context.groupId),
    groupChannel: optionalCacheString(context.groupChannel),
    groupSpace: optionalCacheString(context.groupSpace),
    replyToMode: optionalCacheString(context.replyToMode),
  });
}

function trimToolsEffectiveCache(): void {
  while (toolsEffectiveCache.size > TOOLS_EFFECTIVE_CACHE_LIMIT) {
    const oldest = toolsEffectiveCache.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    toolsEffectiveCache.delete(oldest);
  }
}

function cacheToolsEffectiveResult(key: string, value: EffectiveToolInventoryResult): void {
  toolsEffectiveCache.delete(key);
  toolsEffectiveCache.set(key, { value, createdAtMs: nowForToolsEffectiveCache() });
  trimToolsEffectiveCache();
}

function countToolsEffectiveEntries(value: EffectiveToolInventoryResult): number {
  return value.groups.reduce((sum, group) => sum + group.tools.length, 0);
}

function resolveAndCacheToolsEffectiveResult(params: {
  key: string;
  context: TrustedToolsEffectiveContext;
  startedAt: number;
}): EffectiveToolInventoryResult {
  const value = resolveEffectiveToolInventory({
    cfg: params.context.cfg,
    agentId: params.context.agentId,
    sessionKey: params.context.sessionKey,
    messageProvider: params.context.messageProvider,
    modelProvider: params.context.modelProvider,
    modelId: params.context.modelId,
    senderIsOwner: params.context.senderIsOwner,
    currentChannelId: params.context.currentChannelId,
    currentThreadTs: params.context.currentThreadTs,
    accountId: params.context.accountId,
    groupId: params.context.groupId,
    groupChannel: params.context.groupChannel,
    groupSpace: params.context.groupSpace,
    replyToMode: params.context.replyToMode,
  });
  cacheToolsEffectiveResult(params.key, value);
  const durationMs = nowForToolsEffectiveCache() - params.startedAt;
  if (durationMs >= TOOLS_EFFECTIVE_SLOW_LOG_MS) {
    logDebug(
      `tools-effective: refresh durationMs=${durationMs} agent=${params.context.agentId} session=${params.context.sessionKey} tools=${countToolsEffectiveEntries(value)}`,
    );
  }
  return value;
}

function scheduleToolsEffectiveRefresh(
  key: string,
  context: TrustedToolsEffectiveContext,
  options: { defer?: boolean } = {},
): Promise<EffectiveToolInventoryResult> {
  const existing = toolsEffectiveInflight.get(key);
  if (existing) {
    return existing;
  }
  const startedAt = nowForToolsEffectiveCache();
  let completed = false;
  let cancelImmediate: (() => void) | undefined;
  let cancelFallback: (() => void) | undefined;
  let resolveTask!: (value: EffectiveToolInventoryResult) => void;
  let rejectTask!: (reason: unknown) => void;
  const task = new Promise<EffectiveToolInventoryResult>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  toolsEffectiveInflight.set(key, task);

  const run = () => {
    if (completed) {
      return;
    }
    completed = true;
    cancelImmediate?.();
    cancelFallback?.();
    try {
      resolveTask(resolveAndCacheToolsEffectiveResult({ key, context, startedAt }));
    } catch (err) {
      rejectTask(err);
    } finally {
      toolsEffectiveInflight.delete(key);
    }
  };

  if (options.defer === false) {
    run();
    return task;
  }

  try {
    cancelImmediate = scheduleToolsEffectiveImmediate(run);
  } catch {
    run();
    return task;
  }

  if (toolsEffectiveRefreshFallbackMs > 0) {
    try {
      cancelFallback = scheduleToolsEffectiveFallbackTimeout(run, toolsEffectiveRefreshFallbackMs);
    } catch {
      // If the fallback timer cannot be scheduled, keep the original setImmediate path.
    }
  }

  return task;
}

function refreshToolsEffectiveInBackground(
  key: string,
  context: TrustedToolsEffectiveContext,
): void {
  void scheduleToolsEffectiveRefresh(key, context).catch((err) => {
    logWarn(`tools-effective: background refresh failed: ${String(err)}`);
  });
}

async function resolveCachedToolsEffective(params: {
  sessionKey: string;
  context: TrustedToolsEffectiveContext;
}): Promise<EffectiveToolInventoryResult> {
  const key = buildToolsEffectiveCacheKey(params);
  const now = nowForToolsEffectiveCache();
  const cached = toolsEffectiveCache.get(key);
  if (cached) {
    const ageMs = now - cached.createdAtMs;
    if (ageMs < TOOLS_EFFECTIVE_FRESH_TTL_MS) {
      return cached.value;
    }
    if (ageMs < TOOLS_EFFECTIVE_STALE_TTL_MS) {
      refreshToolsEffectiveInBackground(key, params.context);
      return cached.value;
    }
  }
  return scheduleToolsEffectiveRefresh(key, params.context, { defer: false });
}

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  senderIsOwner: boolean;
  respond: RespondFn;
}) {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: loaded.canonicalKey ?? params.sessionKey,
    config: loaded.cfg,
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider:
      delivery?.channel ??
      loaded.entry.lastChannel ??
      loaded.entry.channel ??
      loaded.entry.origin?.provider,
    accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? stringifyRouteThreadId(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? stringifyRouteThreadId(loaded.entry.origin.threadId)
            : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ??
        loaded.entry.lastChannel ??
        loaded.entry.channel ??
        loaded.entry.origin?.provider,
      delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
  };
}

type ToolsEffectiveStartupPrewarmCandidate = {
  sessionKey: string;
  updatedAtMs: number;
  priority: number;
};

export type ToolsEffectiveStartupPrewarmResult = {
  sessionCount: number;
  attempted: number;
  warmed: number;
  failed: number;
  skipped: number;
};

function collectToolsEffectiveStartupPrewarmCandidates(params: {
  cfg: OpenClawConfig;
  limit?: number;
}): ToolsEffectiveStartupPrewarmCandidate[] {
  const mainSessionKeys = new Set(
    listAgentIds(params.cfg).map((agentId) =>
      resolveAgentMainSessionKey({ cfg: params.cfg, agentId }),
    ),
  );
  const candidates = new Map<string, ToolsEffectiveStartupPrewarmCandidate>();
  const addCandidate = (sessionKey: string, updatedAt: unknown) => {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    const updatedAtMs = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0;
    const priority = mainSessionKeys.has(key) ? 1 : 0;
    const existing = candidates.get(key);
    if (
      !existing ||
      priority > existing.priority ||
      (priority === existing.priority && updatedAtMs > existing.updatedAtMs)
    ) {
      candidates.set(key, { sessionKey: key, updatedAtMs, priority });
    }
  };

  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    const store = loadSessionStore(target.storePath);
    for (const [sessionKey, entry] of Object.entries(store)) {
      addCandidate(sessionKey, entry?.updatedAt);
    }
  }

  return [...candidates.values()]
    .toSorted(
      (a, b) =>
        b.priority - a.priority ||
        b.updatedAtMs - a.updatedAtMs ||
        a.sessionKey.localeCompare(b.sessionKey),
    )
    .slice(0, params.limit ?? TOOLS_EFFECTIVE_STARTUP_PREWARM_SESSION_LIMIT);
}

export function prewarmToolsEffectiveCacheForStartup(params: {
  cfg: OpenClawConfig;
  log?: { warn?: (msg: string) => void };
  sessionLimit?: number;
}): ToolsEffectiveStartupPrewarmResult {
  let candidates: ToolsEffectiveStartupPrewarmCandidate[];
  try {
    candidates = collectToolsEffectiveStartupPrewarmCandidates({
      cfg: params.cfg,
      limit: params.sessionLimit,
    });
  } catch (err) {
    params.log?.warn?.(`tools-effective startup prewarm skipped: ${String(err)}`);
    return { sessionCount: 0, attempted: 0, warmed: 0, failed: 0, skipped: 0 };
  }

  let attempted = 0;
  let warmed = 0;
  let failed = 0;
  let skipped = 0;
  let firstFailure: unknown;
  const respond: RespondFn = () => undefined;

  for (const candidate of candidates) {
    const baseContext = resolveTrustedToolsEffectiveContext({
      sessionKey: candidate.sessionKey,
      senderIsOwner: false,
      respond,
    });
    if (!baseContext) {
      skipped += 1;
      continue;
    }

    for (const senderIsOwner of [true, false]) {
      const context = { ...baseContext, senderIsOwner };
      const key = buildToolsEffectiveCacheKey({ sessionKey: candidate.sessionKey, context });
      if (toolsEffectiveCache.has(key) || toolsEffectiveInflight.has(key)) {
        skipped += 1;
        continue;
      }
      attempted += 1;
      try {
        resolveAndCacheToolsEffectiveResult({
          key,
          context,
          startedAt: nowForToolsEffectiveCache(),
        });
        warmed += 1;
      } catch (err) {
        failed += 1;
        firstFailure ??= err;
      }
    }
  }

  if (failed > 0) {
    params.log?.warn?.(
      `tools-effective startup prewarm failed for ${failed}/${attempted} inventory refreshes: ${String(firstFailure)}`,
    );
  }
  if (warmed > 0) {
    logDebug(
      `tools-effective: startup prewarm sessions=${candidates.length} warmed=${warmed} skipped=${skipped} failed=${failed}`,
    );
  }
  return { sessionCount: candidates.length, attempted, warmed, failed, skipped };
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": async ({ params, respond, client, context }) => {
    if (!validateToolsEffectiveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgentId = resolveRequestedAgentIdOrRespondError({
      rawAgentId: params.agentId,
      cfg,
      respond,
    });
    if (requestedAgentId === null) {
      return;
    }
    const trustedContext = resolveTrustedToolsEffectiveContext({
      sessionKey: params.sessionKey,
      requestedAgentId,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      respond,
    });
    if (!trustedContext) {
      return;
    }
    try {
      respond(
        true,
        await resolveCachedToolsEffective({
          sessionKey: params.sessionKey,
          context: trustedContext,
        }),
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `tools.effective failed: ${String(err)}`),
      );
    }
  },
};

export const __testing = {
  resetToolsEffectiveCacheForTest() {
    toolsEffectiveCache.clear();
    toolsEffectiveInflight.clear();
  },
  setToolsEffectiveNowForTest(now: () => number) {
    nowForToolsEffectiveCache = now;
  },
  resetToolsEffectiveNowForTest() {
    nowForToolsEffectiveCache = () => Date.now();
  },
  setToolsEffectiveImmediateSchedulerForTest(scheduler: (callback: () => void) => () => void) {
    scheduleToolsEffectiveImmediate = scheduler;
  },
  setToolsEffectiveFallbackTimeoutSchedulerForTest(
    scheduler: (callback: () => void, delayMs: number) => () => void,
  ) {
    scheduleToolsEffectiveFallbackTimeout = scheduler;
  },
  setToolsEffectiveRefreshFallbackMsForTest(delayMs: number) {
    toolsEffectiveRefreshFallbackMs = delayMs;
  },
  resetToolsEffectiveSchedulersForTest() {
    toolsEffectiveRefreshFallbackMs = TOOLS_EFFECTIVE_REFRESH_FALLBACK_MS;
    scheduleToolsEffectiveImmediate = (callback: () => void) => {
      const handle = setImmediate(callback);
      return () => clearImmediate(handle);
    };
    scheduleToolsEffectiveFallbackTimeout = (callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    };
  },
} as const;
