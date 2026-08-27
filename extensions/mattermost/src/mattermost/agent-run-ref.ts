export type MattermostAgentRunRefV3 = {
  schemaVersion: 3;
  projectionKind: "run";
  conversationId: string;
  turnId: string;
  runId: string;
  agentId: string;
  sessionKey: string;
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isUnknownRecord(value) ? value : undefined;
}

function isOptionalRunRefString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalRunRefNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isOrigin(value: unknown): value is MattermostAgentRunRefV3["origin"] {
  return (
    value === "human" ||
    value === "followup" ||
    value === "retry" ||
    value === "scheduled" ||
    value === "subagent"
  );
}

function isStatus(value: unknown): value is MattermostAgentRunRefV3["status"] {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
  );
}

function isAttention(value: unknown): value is MattermostAgentRunRefV3["attention"] {
  return value === "routine" || value === "action-required" || value === "failure";
}

function isMattermostAgentRunRefV3(value: unknown): value is MattermostAgentRunRefV3 {
  const ref = record(value);
  return (
    ref?.schemaVersion === 3 &&
    ref.projectionKind === "run" &&
    typeof ref.conversationId === "string" &&
    typeof ref.turnId === "string" &&
    typeof ref.runId === "string" &&
    typeof ref.agentId === "string" &&
    typeof ref.sessionKey === "string" &&
    isOptionalRunRefString(ref.parentRunId) &&
    isOptionalRunRefString(ref.retryOfRunId) &&
    isOrigin(ref.origin) &&
    isStatus(ref.status) &&
    typeof ref.mainChannelId === "string" &&
    typeof ref.mainRootPostId === "string" &&
    isOptionalRunRefString(ref.inputPostId) &&
    typeof ref.activityChannelId === "string" &&
    typeof ref.activityRootPostId === "string" &&
    isOptionalRunRefString(ref.itemId) &&
    isOptionalRunRefString(ref.toolCallId) &&
    isOptionalRunRefNumber(ref.ordinal) &&
    isOptionalRunRefNumber(ref.semanticVersion) &&
    isAttention(ref.attention)
  );
}

function runRef(value: unknown): MattermostAgentRunRefV3 | undefined {
  return isMattermostAgentRunRefV3(value) ? value : undefined;
}

function sameImmutableRunIdentity(
  current: MattermostAgentRunRefV3,
  next: MattermostAgentRunRefV3,
): boolean {
  return (
    current.conversationId === next.conversationId &&
    current.turnId === next.turnId &&
    current.runId === next.runId &&
    current.agentId === next.agentId &&
    current.sessionKey === next.sessionKey &&
    current.parentRunId === next.parentRunId &&
    current.retryOfRunId === next.retryOfRunId &&
    current.origin === next.origin &&
    current.mainChannelId === next.mainChannelId &&
    current.mainRootPostId === next.mainRootPostId &&
    current.inputPostId === next.inputPostId &&
    current.activityChannelId === next.activityChannelId &&
    current.activityRootPostId === next.activityRootPostId
  );
}

export function mergeVerifiedMattermostAgentRunProps(input: {
  post: {
    id?: string | null;
    channel_id?: string | null;
    root_id?: string | null;
    props?: Record<string, unknown> | null;
  };
  expectedPostId: string;
  expectedChannelId: string;
  expectedRootId?: string;
  nextProps: Record<string, unknown>;
}): Record<string, unknown> {
  if (
    input.post.id !== input.expectedPostId ||
    input.post.channel_id !== input.expectedChannelId ||
    (input.post.root_id ?? "") !== (input.expectedRootId ?? "")
  ) {
    throw new Error("Mattermost run post binding mismatch");
  }
  const currentProps = input.post.props ?? {};
  const currentOctogee = record(currentProps.octogee);
  const nextOctogee = record(input.nextProps.octogee);
  const currentRef = runRef(currentOctogee);
  const nextRef = runRef(nextOctogee);
  if (!currentRef || !nextRef || !sameImmutableRunIdentity(currentRef, nextRef)) {
    throw new Error("Mattermost run identity mismatch");
  }
  return {
    ...currentProps,
    ...input.nextProps,
    octogee: { ...currentOctogee, ...nextOctogee },
  };
}
