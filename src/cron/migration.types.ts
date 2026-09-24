import type { CronStoredJob } from "./types.js";

export type CronMigrationPhase =
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
};
export type CronMigrationRequest = {
  operationId: string;
  phase: CronMigrationPhase;
  agentIds?: string[];
  snapshot?: CronMigrationSnapshot;
};
export type CronMigrationResult = {
  operationId: string;
  phase: CronMigrationPhase;
  agentIds: string[];
  drained: boolean;
  snapshot?: CronMigrationSnapshot;
};
