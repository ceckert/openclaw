type AgentActivityLiveState = {
  phase: string;
  elapsedMs: number;
  activeItemId?: string;
  tokens?: {
    input: number;
    output: number;
    contextUsed?: number;
    contextWindow?: number;
  };
};

type AgentActivitySnapshotRun = {
  agentId: string;
  sessionKey: string;
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  origin: "human" | "followup" | "retry" | "scheduled" | "subagent";
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
  activityChannelId: string;
  activityRootPostId: string;
  startedAt: number;
  revision: number;
  status: "running" | "waiting";
  live: AgentActivityLiveState;
};

export type AgentActivitySnapshotAdmission = {
  inputPostId: string;
  conversationId: string;
  turnId: string;
  mainChannelId: string;
  activityChannelId?: string;
  origin: "human" | "followup" | "retry" | "scheduled";
  retryOfRunId?: string;
  status: "received" | "queued" | "blocked";
  queuePosition?: number;
  revision: number;
};

export type AgentActivitySnapshotV1 = {
  schemaVersion: 1;
  generatedAt: number;
  runs: AgentActivitySnapshotRun[];
  admissions: AgentActivitySnapshotAdmission[];
};

export type AgentActivityTerminalRun = Omit<
  AgentActivitySnapshotRun,
  "status" | "live" | "revision"
> & {
  primaryPostId?: string;
  outcome: "completed" | "failed" | "stopped";
  finishedAt: number;
  revision: number;
};

type PendingAgentActivityRun = Omit<
  AgentActivitySnapshotRun,
  "activityChannelId" | "activityRootPostId"
> & {
  activityChannelId?: string;
  activityRootPostId?: string;
  primaryPostId?: string;
};

type BoundAgentActivityRun = AgentActivitySnapshotRun & { primaryPostId?: string };

export type AgentActivityResolvedRun =
  | (AgentActivitySnapshotRun & { primaryPostId?: string })
  | AgentActivityTerminalRun;

export type AgentActivityPrimaryPostBindingResult =
  | { outcome: "bound" | "already-bound" | "cleared" | "not-found" }
  | { outcome: "binding-mismatch"; ownerRunId: string };

type StartRun = Omit<PendingAgentActivityRun, "revision">;
type RunUpdate = Partial<Pick<AgentActivitySnapshotRun, "status" | "live">>;
type ActivityBinding = Pick<AgentActivitySnapshotRun, "activityChannelId" | "activityRootPostId">;

function isBoundRun(run: PendingAgentActivityRun): run is BoundAgentActivityRun {
  return Boolean(run.activityChannelId && run.activityRootPostId);
}

export function createAgentActivityRuntime(options?: {
  now?: () => number;
  readAdmissions?: () => Promise<AgentActivitySnapshotAdmission[]>;
  writeTerminal?: (run: AgentActivityTerminalRun) => Promise<void>;
  readTerminal?: (runId: string) => Promise<AgentActivityTerminalRun | undefined>;
}) {
  const now = options?.now ?? Date.now;
  const readAdmissions = options?.readAdmissions ?? (async () => []);
  const runs = new Map<string, PendingAgentActivityRun>();
  const terminals = new Map<string, AgentActivityTerminalRun>();
  const primaryPostOwners = new Map<string, string>();

  const rememberPrimaryPostOwner = (run: { runId: string; primaryPostId?: string }): void => {
    if (!run.primaryPostId) {
      return;
    }
    const owner = primaryPostOwners.get(run.primaryPostId);
    if (owner && owner !== run.runId) {
      throw new Error(
        `Agent activity primary post ${run.primaryPostId} is already owned by ${owner}`,
      );
    }
    primaryPostOwners.set(run.primaryPostId, run.runId);
  };

  const startRun = (run: StartRun): PendingAgentActivityRun => {
    const terminal = terminals.get(run.runId);
    if (terminal) {
      throw new Error(`Agent activity run ${run.runId} is already terminal`);
    }
    const current = runs.get(run.runId);
    if (current) {
      return current;
    }
    const stored: PendingAgentActivityRun = { ...run, revision: 1 };
    runs.set(run.runId, stored);
    return stored;
  };

  const bindRunActivity = (runId: string, binding: ActivityBinding): boolean => {
    const current = runs.get(runId);
    if (!current) {
      throw new Error(`Agent activity run ${runId} is unavailable for Activity binding`);
    }
    if (!binding.activityChannelId.trim() || !binding.activityRootPostId.trim()) {
      throw new Error(`Agent activity run ${runId} has an invalid Activity binding`);
    }
    if (current.activityChannelId || current.activityRootPostId) {
      if (
        current.activityChannelId !== binding.activityChannelId ||
        current.activityRootPostId !== binding.activityRootPostId
      ) {
        throw new Error(`Agent activity run ${runId} Activity binding conflict`);
      }
      return false;
    }
    runs.set(runId, {
      ...current,
      ...binding,
      revision: current.revision + 1,
    });
    return true;
  };

  const updateRun = (runId: string, update: RunUpdate): boolean => {
    const current = runs.get(runId);
    if (!current) {
      return false;
    }
    runs.set(runId, {
      ...current,
      ...update,
      ...(update.live ? { live: update.live } : {}),
      revision: current.revision + 1,
    });
    return true;
  };

  const bindRunPrimaryPost = (
    runId: string,
    primaryPostId: string,
  ): AgentActivityPrimaryPostBindingResult => {
    if (!primaryPostId.trim() || primaryPostId !== primaryPostId.trim()) {
      throw new Error(`Agent activity run ${runId} has an invalid primary post receipt`);
    }
    const current = runs.get(runId);
    if (!current) {
      return { outcome: "not-found" };
    }
    const owner = primaryPostOwners.get(primaryPostId);
    if (owner && owner !== runId) {
      return { outcome: "binding-mismatch", ownerRunId: owner };
    }
    if (current.primaryPostId === primaryPostId) {
      return { outcome: "already-bound" };
    }
    if (current.primaryPostId) {
      return { outcome: "binding-mismatch", ownerRunId: runId };
    }
    primaryPostOwners.set(primaryPostId, runId);
    runs.set(runId, {
      ...current,
      primaryPostId,
      revision: current.revision + 1,
    });
    return { outcome: "bound" };
  };

  const clearRunPrimaryPost = (
    runId: string,
    primaryPostId: string,
  ): AgentActivityPrimaryPostBindingResult => {
    const current = runs.get(runId);
    if (!current) {
      return { outcome: "not-found" };
    }
    if (current.primaryPostId !== primaryPostId) {
      return { outcome: "binding-mismatch", ownerRunId: runId };
    }
    const { primaryPostId: _primaryPostId, ...withoutPrimaryPost } = current;
    runs.set(runId, {
      ...withoutPrimaryPost,
      revision: current.revision + 1,
    });
    return { outcome: "cleared" };
  };

  const finishRun = async (
    runId: string,
    outcome: AgentActivityTerminalRun["outcome"],
  ): Promise<AgentActivityTerminalRun | undefined> => {
    const alreadyTerminal = terminals.get(runId) ?? (await options?.readTerminal?.(runId));
    if (alreadyTerminal) {
      rememberPrimaryPostOwner(alreadyTerminal);
      terminals.set(runId, alreadyTerminal);
      return alreadyTerminal;
    }
    const current = runs.get(runId);
    if (!current) {
      return undefined;
    }
    if (!isBoundRun(current)) {
      throw new Error(`Agent activity run ${runId} has no acknowledged Activity binding`);
    }
    const { status: _status, live: _live, ...identity } = current;
    const terminal: AgentActivityTerminalRun = {
      ...identity,
      outcome,
      finishedAt: now(),
      revision: current.revision + 1,
    };
    await options?.writeTerminal?.(terminal);
    rememberPrimaryPostOwner(terminal);
    terminals.set(runId, terminal);
    runs.delete(runId);
    return terminal;
  };

  const abandonRun = (runId: string): boolean => runs.delete(runId);

  const resolveRun = async (runId: string): Promise<AgentActivityResolvedRun | undefined> => {
    const active = runs.get(runId);
    if (active && isBoundRun(active)) {
      return active;
    }
    const cached = terminals.get(runId);
    if (cached) {
      return cached;
    }
    const durable = await options?.readTerminal?.(runId);
    if (durable) {
      rememberPrimaryPostOwner(durable);
      terminals.set(runId, durable);
    }
    return durable;
  };

  const activeRunForConversation = (conversationId: string): PendingAgentActivityRun | undefined =>
    [...runs.values()]
      .filter((run) => run.conversationId === conversationId)
      .toSorted((a, b) => b.startedAt - a.startedAt || b.revision - a.revision)[0];

  const snapshot = async (): Promise<AgentActivitySnapshotV1> => ({
    schemaVersion: 1,
    generatedAt: now(),
    runs: [...runs.values()]
      .filter(isBoundRun)
      .map(({ primaryPostId: _primaryPostId, ...run }) => run)
      .toSorted((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)),
    admissions: (await readAdmissions()).toSorted(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) -
          (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
        a.inputPostId.localeCompare(b.inputPostId),
    ),
  });

  return {
    startRun,
    bindRunActivity,
    bindRunPrimaryPost,
    clearRunPrimaryPost,
    updateRun,
    finishRun,
    abandonRun,
    resolveRun,
    activeRunForConversation,
    snapshot,
  };
}

export type AgentActivityRuntime = ReturnType<typeof createAgentActivityRuntime>;
