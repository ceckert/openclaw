// Mattermost plugin module shares monitor-scoped runtime dependencies.
import type { getMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { createAgentActivityOutbox } from "./activity-outbox.js";
import type { createAgentActivityRuntime } from "./activity-runtime.js";
import type { createMattermostAdmissionService } from "./admission.js";
import type { MattermostClient } from "./client.js";
import type { createMattermostMonitorResources } from "./monitor-resources.js";
import type {
  ChannelAccountSnapshot,
  createChannelPairingController,
  OpenClawConfig,
  RuntimeEnv,
} from "./runtime-api.js";

export type MattermostMonitorContext = {
  core: ReturnType<typeof getMattermostRuntime>;
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  account: ResolvedMattermostAccount;
  client: MattermostClient;
  pairing: ReturnType<typeof createChannelPairingController>;
  botUserId: string;
  botUsername?: string;
  groupPolicy: "allowlist" | "open" | "disabled";
  resources: ReturnType<typeof createMattermostMonitorResources>;
  logDebugMessage: (message: string) => void;
  logVerboseMessage: (message: string) => void;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  /**
   * [octogee-patch] Durable run admission + agent-activity publication. Present
   * only when the account opts in via `agentActivity`; the post and turn paths
   * fall back to vanilla behavior when these are undefined.
   */
  activityEnabled: boolean;
  mediaMaxBytes: number;
  activityStartTimeoutMs?: number;
  abortSignal?: AbortSignal;
  admissionService?: ReturnType<typeof createMattermostAdmissionService>;
  activityRuntime?: ReturnType<typeof createAgentActivityRuntime>;
  activityOutbox?: ReturnType<typeof createAgentActivityOutbox>;
};
