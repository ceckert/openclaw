import type { CronFailureNotificationDelivery } from "../types.js";
import type { CronRunRecoveryProposal } from "./run-recovery-read.types.js";

export type CronScheduleMaintenanceOptions = {
  recomputeExpired?: boolean;
  nowMs?: number;
  repairFutureCronNextRunAtMs?: boolean;
  preserveExpiredPacedNextRunJobId?: string;
  skipScheduleErrorHandling?: boolean;
};

export type CronRuntimeMutationInputs = {
  "cron.migration": {
    storeKey: string;
    request: import("../migration.types.js").CronMigrationRequest;
  };
  "cron.reserveRuns": {
    storeKey: string;
    candidates: import("../types.js").CronJob[];
    maxReservations: number;
    immediateJobIds: string[];
    reservedAtMs: number;
    ownershipAtMs: number;
    onExit: boolean;
    preserve: boolean;
  };
  "cron.repairRun": {
    storeKey: string;
    proposal: CronRunRecoveryProposal;
    mode: "startup" | "reclaim";
  };
  "cron.scheduleUnowned": {
    storeKey: string;
    options?: CronScheduleMaintenanceOptions;
  };
  "cron.recordFailureAlertOutcome": {
    storeKey: string;
    jobId: string;
    runAtMs: number | undefined;
    alertAtMs: number | undefined;
    notificationId: string | undefined;
    outcome: CronFailureNotificationDelivery;
  };
};

export type CronRuntimeMutationType = keyof CronRuntimeMutationInputs;
export type CronRuntimeWorkerOperations = {
  [Type in CronRuntimeMutationType]: {
    input: CronRuntimeMutationInputs[Type] & { nonce: string };
    output: { nonce: string };
  };
};
