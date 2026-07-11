import type { AgentActivityRuntime, AgentActivitySnapshotV1 } from "./activity-runtime.js";
import type {
  MattermostAdmissionService,
  MattermostIngressRetryResult,
  MattermostIngressStatusResult,
} from "./admission.js";

type RegisteredActivityRuntime = {
  admission: MattermostAdmissionService;
  activity: AgentActivityRuntime;
};

export type MattermostActivityGatewayRuntime = {
  status(inputPostId: string): Promise<MattermostIngressStatusResult | null>;
  cancel(
    inputPostId: string,
    idempotencyKey: string,
  ): ReturnType<MattermostAdmissionService["cancel"]>;
  retry(
    params: Parameters<MattermostAdmissionService["retry"]>[0],
  ): Promise<MattermostIngressRetryResult>;
  snapshot(): Promise<AgentActivitySnapshotV1>;
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
  };
}

export function resetMattermostActivityRuntimesForTests(): void {
  registrations.clear();
}
