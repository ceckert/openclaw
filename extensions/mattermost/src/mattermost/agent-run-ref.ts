export type MattermostAgentRunRefV3 = {
  schemaVersion: 3;
  projectionKind: "run";
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  origin: "human" | "followup" | "retry" | "scheduled" | "subagent";
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
  activityChannelId: string;
  activityRootPostId: string;
  itemId?: string;
  toolCallId?: string;
  ordinal?: number;
  semanticVersion?: number;
  attention: "routine" | "action-required" | "failure";
};

export function buildMattermostAgentRunProps(
  ref: MattermostAgentRunRefV3,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, octogee: ref };
}
