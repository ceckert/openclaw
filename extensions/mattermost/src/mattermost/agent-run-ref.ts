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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function runRef(value: unknown): MattermostAgentRunRefV3 | undefined {
  const ref = record(value);
  return ref?.schemaVersion === 3 &&
    ref.projectionKind === "run" &&
    typeof ref.conversationId === "string" &&
    typeof ref.turnId === "string" &&
    typeof ref.runId === "string" &&
    typeof ref.origin === "string" &&
    typeof ref.status === "string" &&
    typeof ref.mainChannelId === "string" &&
    typeof ref.mainRootPostId === "string" &&
    typeof ref.activityChannelId === "string" &&
    typeof ref.activityRootPostId === "string" &&
    typeof ref.attention === "string"
    ? (ref as MattermostAgentRunRefV3)
    : undefined;
}

function sameImmutableRunIdentity(
  current: MattermostAgentRunRefV3,
  next: MattermostAgentRunRefV3,
): boolean {
  return (
    current.conversationId === next.conversationId &&
    current.turnId === next.turnId &&
    current.runId === next.runId &&
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
