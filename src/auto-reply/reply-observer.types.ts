import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.types.js";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { ReplyPayload } from "../shared/reply-payload.types.js";

/** A successful runtime append, independent of optional active-path projection anchors. */
export type ReplyDispatchAssistantTranscript = Pick<
  TranscriptEntryAnchor,
  "agentId" | "sessionId" | "sessionKey" | "storePath"
> & {
  messageId: string;
  anchor?: TranscriptEntryAnchor;
  idempotencyKey: string;
};

export type ReplyDispatchRun = {
  completionSource: "reply-dispatch";
  getResult: () => {
    assistantTranscript?: ReplyDispatchAssistantTranscript;
    terminalOutcome?: AgentRunTerminalOutcome;
  };
};

/** Prepared transcript boundary; current run and writer authority remain caller-owned. */
export type PreparedReplyTranscriptStart = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  generation: string | null;
  maxSeq: number | null;
};

/** Partial assistant payload emitted during streaming or replacement updates. */
export type PartialReplyPayload = {
  /**
   * Sanitized text, which may be an enumerable memoized getter. Content materializes on first
   * read: direct-delivery consumers pay per partial, while throttled consumers pay per flush.
   */
  text?: ReplyPayload["text"];
  mediaUrls?: ReplyPayload["mediaUrls"];
  delta?: string;
  replace?: true;
};

/** Return false until the channel has accepted operator-visible progress. */
export type ProgressCallbackResult = boolean | void;

export type ReplyObserverCallbacks = {
  /**
   * Notifies when an agent run starts. Return "reply-dispatch" synchronously to accept
   * completion ownership offered in options; all other legacy callback results are ignored.
   */
  onAgentRunStart?: (
    runId: string,
    executionIdentityToken?: ExecutionIdentityAdmissionToken,
    options?: ReplyDispatchRun,
    transcriptStart?: PreparedReplyTranscriptStart | null,
  ) => unknown;
  onPartialReply?: (
    payload: PartialReplyPayload,
  ) => Promise<ProgressCallbackResult> | ProgressCallbackResult;
  /** Called when a new assistant message starts (e.g., after tool call or thinking block). */
  onAssistantMessageStart?: () => Promise<ProgressCallbackResult> | ProgressCallbackResult;
};
