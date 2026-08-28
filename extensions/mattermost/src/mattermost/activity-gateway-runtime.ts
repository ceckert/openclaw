import type {
  AgentActivityResolvedRun,
  AgentActivityRuntime,
  AgentActivitySnapshotV1,
} from "./activity-runtime.js";
import type {
  MattermostAdmissionService,
  MattermostIngressRetryResult,
  MattermostIngressStatusResult,
} from "./admission.js";
import type { MattermostAgentRunRefV3 } from "./agent-run-ref.js";

type RegisteredActivityRuntime = {
  admission: MattermostAdmissionService;
  activity: AgentActivityRuntime;
};

type MattermostActivityResolvedRunV3 = {
  ref: MattermostAgentRunRefV3;
  agentId: string;
  sessionKey: string;
  primaryPostId?: string;
  startedAt: number;
  finishedAt?: number;
  revision: number;
};

type MattermostActivityRunLookupResult =
  | { outcome: "found"; run: MattermostActivityResolvedRunV3 }
  | { outcome: "not-found" | "identity-mismatch"; runId: string };

export type MattermostActivityGatewayRuntime = {
  status: (inputPostId: string) => Promise<MattermostIngressStatusResult | null>;
  cancel: (
    inputPostId: string,
    idempotencyKey: string,
  ) => ReturnType<MattermostAdmissionService["cancel"]>;
  retry: (
    params: Parameters<MattermostAdmissionService["retry"]>[0],
  ) => Promise<MattermostIngressRetryResult>;
  snapshot: () => Promise<AgentActivitySnapshotV1>;
  resolveRun: (runId: string) => Promise<MattermostActivityRunLookupResult>;
};

const registrations = new Map<string, RegisteredActivityRuntime>();

export function registerMattermostActivityRuntime(
  accountId: string,
  runtime: RegisteredActivityRuntime,
): () => void {
  registrations.set(accountId, runtime);
  return () => {
    if (registrations.get(accountId) === runtime) {
      registrations.delete(accountId);
    }
  };
}

export function getMattermostActivityGatewayRuntime(): MattermostActivityGatewayRuntime {
  return {
    status: async (inputPostId) => {
      for (const registration of registrations.values()) {
        const status = await registration.admission.status(inputPostId);
        if (status) {
          return status;
        }
      }
      return null;
    },
    cancel: async (inputPostId, idempotencyKey) => {
      for (const registration of registrations.values()) {
        if (await registration.admission.status(inputPostId)) {
          return await registration.admission.cancel(inputPostId, idempotencyKey);
        }
      }
      return { outcome: "not-found" };
    },
    retry: async (params) => {
      for (const registration of registrations.values()) {
        const result = await registration.admission.retry(params);
        if (result.outcome !== "source-missing") {
          return result;
        }
      }
      return { outcome: "source-missing" };
    },
    snapshot: async () => {
      const snapshots = await Promise.all(
        [...registrations.values()].map((registration) => registration.activity.snapshot()),
      );
      return {
        schemaVersion: 1,
        generatedAt: Date.now(),
        runs: snapshots
          .flatMap((snapshot) => snapshot.runs)
          .toSorted((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)),
        admissions: snapshots
          .flatMap((snapshot) => snapshot.admissions)
          .toSorted(
            (a, b) =>
              (a.queuePosition ?? Number.MAX_SAFE_INTEGER) -
                (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
              a.inputPostId.localeCompare(b.inputPostId),
          ),
      };
    },
    resolveRun: async (runId) => {
      const matches = (
        await Promise.all(
          [...registrations.values()].map((registration) =>
            registration.activity.resolveRun(runId),
          ),
        )
      ).filter((run): run is AgentActivityResolvedRun => run !== undefined);
      if (matches.length === 0) {
        return { outcome: "not-found", runId };
      }
      const [run] = matches;
      if (!run || matches.length !== 1 || run.runId !== runId) {
        return { outcome: "identity-mismatch", runId };
      }
      const status = "outcome" in run ? run.outcome : run.status;
      const ref: MattermostAgentRunRefV3 = {
        schemaVersion: 3,
        projectionKind: "run",
        conversationId: run.conversationId,
        turnId: run.turnId,
        runId: run.runId,
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.retryOfRunId ? { retryOfRunId: run.retryOfRunId } : {}),
        origin: run.origin,
        status,
        mainChannelId: run.mainChannelId,
        mainRootPostId: run.mainRootPostId,
        ...(run.inputPostId ? { inputPostId: run.inputPostId } : {}),
        activityChannelId: run.activityChannelId,
        activityRootPostId: run.activityRootPostId,
        attention:
          status === "waiting"
            ? "action-required"
            : status === "failed" || status === "stopped"
              ? "failure"
              : "routine",
      };
      return {
        outcome: "found",
        run: {
          ref,
          agentId: run.agentId,
          sessionKey: run.sessionKey,
          ...(run.primaryPostId ? { primaryPostId: run.primaryPostId } : {}),
          startedAt: run.startedAt,
          ...("finishedAt" in run ? { finishedAt: run.finishedAt } : {}),
          revision: run.revision,
        },
      };
    },
  };
}
