import type { CronStoredJob } from "./types.js";

type CronMigrationPhase =
  | "checkpoint"
  | "hold"
  | "export"
  | "stage"
  | "activate"
  | "resume"
  | "retire"
  | "abort";
export type CronMigrationSnapshot = {
  version: 1;
  operationId: string;
  agentIds: string[];
  jobs: CronStoredJob[];
  scratch: {
    jobId: string;
    content: string | null;
    revision: number;
    sourceSha256: string | null;
    updatedAtMs: number;
  }[];
  /** Nonportable jobs left dormant on the source. */
  retainedJobIds?: string[];
};
export type CronMigrationRequest = {
  operationId: string;
  phase: CronMigrationPhase;
  agentIds?: string[];
  snapshot?: CronMigrationSnapshot;
  /** checkpoint/hold/export/stage only: skip nonportable jobs instead of refusing; they stay fenced on the source. */
  retainNonportable?: boolean;
  targetRequesterProfileId?: string | null;
  /**
   * stage only, set by the Gateway from its staging caller and never accepted as wire input:
   * replacement sources for jobs whose gateway-kind source names the exporting Gateway's device.
   */
  rebindOperatorSources?: Record<string, NonNullable<CronStoredJob["operatorSource"]>>;
};
export type CronMigrationResult = {
  operationId: string;
  phase: CronMigrationPhase;
  agentIds: string[];
  drained: boolean;
  snapshot?: CronMigrationSnapshot;
};
