export type AgentActivityLiveState = {
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

export type AgentActivitySnapshotRun = {
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
};

type StartRun = Omit<PendingAgentActivityRun, "revision">;
type RunUpdate = Partial<Pick<AgentActivitySnapshotRun, "status" | "live">>;
type ActivityBinding = Pick<AgentActivitySnapshotRun, "activityChannelId" | "activityRootPostId">;

function isBoundRun(run: PendingAgentActivityRun): run is AgentActivitySnapshotRun {
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

  const finishRun = async (
    runId: string,
    outcome: AgentActivityTerminalRun["outcome"],
  ): Promise<AgentActivityTerminalRun | undefined> => {
    const alreadyTerminal = terminals.get(runId) ?? (await options?.readTerminal?.(runId));
    if (alreadyTerminal) {
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
    terminals.set(runId, terminal);
    runs.delete(runId);
    return terminal;
  };

  const abandonRun = (runId: string): boolean => runs.delete(runId);

  const resolveRun = async (
    runId: string,
  ): Promise<AgentActivitySnapshotRun | AgentActivityTerminalRun | undefined> => {
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
    updateRun,
    finishRun,
    abandonRun,
    resolveRun,
    activeRunForConversation,
    snapshot,
  };
}

export type AgentActivityRuntime = ReturnType<typeof createAgentActivityRuntime>;
