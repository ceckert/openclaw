import { createHash } from "node:crypto";
import { redactSensitiveText } from "../../logging/redact.js";

export type AgentRunOrigin = "human" | "followup" | "retry" | "scheduled" | "subagent";

export type AgentActivityKind =
  | "commentary"
  | "tool"
  | "plan"
  | "patch"
  | "checkpoint"
  | "compaction"
  | "fallback"
  | "approval"
  | "error";

export type AgentActivityIngressRef = {
  conversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  retryOfRunId?: string;
  agentId: string;
  sessionKey: string;
  origin: AgentRunOrigin;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId?: string;
  itemId: string;
  ordinal: number;
  semanticVersion: number;
};

type AgentActivityEnvelopeBase = {
  schemaVersion: 1;
  eventKey: string;
  emittedAt: string;
  ref: AgentActivityIngressRef;
  redaction: { policy: "octogee-v1"; appliedAt: "producer" };
};

export type AgentActivityEnvelopeV1 =
  | (AgentActivityEnvelopeBase & { type: "turn.started" })
  | (AgentActivityEnvelopeBase & {
      type: "item.completed";
      item: {
        kind: AgentActivityKind;
        status: "completed" | "failed" | "waiting";
        summary: string;
        detail?: { format: "text" | "markdown" | "json"; text: string };
        attachment?: {
          filename: string;
          mediaType: string;
          byteLength: number;
          sha256: string;
          multipartField: "detail";
        };
      };
    })
  | (AgentActivityEnvelopeBase & {
      type: "control.transition";
      control: {
        from: "waiting";
        to: "approved" | "denied" | "expired";
        actorId: string;
      };
    })
  | (AgentActivityEnvelopeBase & {
      type: "turn.finalized";
      outcome: "completed" | "failed" | "stopped";
    });

export type AgentActivityAppend = {
  envelope: AgentActivityEnvelopeV1;
  attachmentBody?: string;
};

export type AgentActivitySink = {
  append(item: AgentActivityAppend): Promise<{ postIds: string[]; activityChannelId: string }>;
};

export type AgentActivityRunBinding = {
  activityChannelId: string;
  activityRootPostId: string;
};

export type AgentActivityItemEvent = {
  itemId?: string;
  toolCallId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
  meta?: string;
  approvalId?: string;
  approvalSlug?: string;
};

type BaseRef = Omit<AgentActivityIngressRef, "itemId" | "ordinal" | "semanticVersion">;
type CompletedStatus = "completed" | "failed" | "waiting";

const COMMENTARY_KINDS = new Set(["preamble", "commentary", "analysis", "thinking", "reasoning"]);
const THINKING_KINDS = new Set(["analysis", "thinking", "reasoning"]);
const TOOL_KINDS = new Set(["tool", "command", "command_output", "search", "api"]);
const SKIPPED_KINDS = new Set([
  "lifecycle",
  "assistant",
  "assistant_response",
  "final",
  "response",
]);
const MUTABLE_SEMANTIC_KINDS = new Set<AgentActivityKind>([
  "plan",
  "patch",
  "checkpoint",
  "compaction",
  "fallback",
]);

const DEFAULT_INLINE_DETAIL_LIMIT_BYTES = 48 * 1024;
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeKind(event: AgentActivityItemEvent): string {
  return normalize(event.kind).toLowerCase();
}

function redact(value: string): string {
  const bearerRedacted = value.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1***");
  return redactSensitiveText(bearerRedacted, { mode: "tools" });
}

export function agentActivityEventKey(
  ref: Pick<AgentActivityIngressRef, "conversationId" | "runId" | "itemId" | "semanticVersion">,
): string {
  return createHash("sha256")
    .update(`v1\n${ref.conversationId}\n${ref.runId}\n${ref.itemId}\n${ref.semanticVersion}`)
    .digest("hex");
}

function completedStatus(event: AgentActivityItemEvent): CompletedStatus | undefined {
  const status = normalize(event.status).toLowerCase();
  const phase = normalize(event.phase).toLowerCase();
  if (["failed", "error", "errored"].includes(status)) {
    return "failed";
  }
  if (["waiting", "pending", "approval", "blocked"].includes(status)) {
    return "waiting";
  }
  if (
    ["completed", "complete", "done", "success", "succeeded"].includes(status) ||
    ["end", "result", "complete", "completed"].includes(phase)
  ) {
    return "completed";
  }
  return undefined;
}

function activityKind(event: AgentActivityItemEvent): AgentActivityKind {
  const kind = normalizeKind(event);
  if (TOOL_KINDS.has(kind)) {
    return "tool";
  }
  if (kind === "plan") {
    return "plan";
  }
  if (kind === "patch") {
    return "patch";
  }
  if (kind === "checkpoint") {
    return "checkpoint";
  }
  if (kind === "compaction") {
    return "compaction";
  }
  if (kind === "fallback") {
    return "fallback";
  }
  if (kind === "approval") {
    return "approval";
  }
  if (kind === "error") {
    return "error";
  }
  return "commentary";
}

function normalizedItemId(event: AgentActivityItemEvent, fallbackIndex: number): string {
  const kind = normalizeKind(event);
  if (kind === "error") {
    return "octogee:terminal-error";
  }
  const approvalId = normalize(event.approvalId);
  if (approvalId) {
    return `octogee:approval:${approvalId}`;
  }
  const safeSourceId = (value: string): string => {
    const normalized = value.replace(/^(tool|command|command_output|patch):/, "");
    return normalized.startsWith("octogee:") ? `source:${normalized}` : normalized;
  };
  const toolCallId = normalize(event.toolCallId);
  if (toolCallId) {
    return safeSourceId(toolCallId);
  }
  const itemId = normalize(event.itemId);
  if (itemId) {
    const safeItemId = safeSourceId(itemId);
    return kind === "approval" ? `octogee:approval:${safeItemId}` : safeItemId;
  }
  return `octogee:item:${fallbackIndex}`;
}

function eventText(event: AgentActivityItemEvent): string {
  return (
    normalize(event.progressText) ||
    normalize(event.summary) ||
    normalize(event.meta) ||
    normalize(event.title) ||
    normalize(event.name) ||
    normalize(event.status) ||
    normalize(event.kind)
  );
}

function summaryForEvent(event: AgentActivityItemEvent, detail: string): string {
  const summary = normalize(event.summary) || normalize(event.title) || normalize(event.name);
  return redact(summary || detail).slice(0, 4000);
}

function safeFilename(itemId: string): string {
  const stem = itemId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return `${stem || "activity-detail"}.md`;
}

/** Creates one channel-neutral durable Activity publisher for an agent run. */
export function createAgentActivityPublisher(params: {
  ref: BaseRef;
  sink: AgentActivitySink;
  inlineDetailLimitBytes?: number;
  maxAttachmentBytes?: number;
  now?: () => Date;
}) {
  const now = params.now ?? (() => new Date());
  const inlineDetailLimitBytes = Math.max(
    0,
    Math.floor(params.inlineDetailLimitBytes ?? DEFAULT_INLINE_DETAIL_LIMIT_BYTES),
  );
  const maxAttachmentBytes = Math.max(
    inlineDetailLimitBytes,
    Math.floor(params.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES),
  );
  const commentary = new Map<string, string>();
  const emittedVersions = new Map<string, { body: string; version: number }>();
  const approvalTransitions = new Map<string, "approved" | "denied" | "expired">();
  let ordinal = 0;
  let fallbackIndex = 0;
  let finalized = false;
  let binding: AgentActivityRunBinding | undefined;
  let startPromise: Promise<AgentActivityRunBinding> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(work);
    return chain;
  };

  const refFor = (itemId: string, itemOrdinal: number, semanticVersion = 1) => ({
    ...params.ref,
    itemId,
    ordinal: itemOrdinal,
    semanticVersion,
  });

  const appendEnvelope = async (
    envelope:
      | Omit<
          Extract<AgentActivityEnvelopeV1, { type: "turn.started" }>,
          keyof AgentActivityEnvelopeBase
        >
      | Omit<
          Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>,
          keyof AgentActivityEnvelopeBase
        >
      | Omit<
          Extract<AgentActivityEnvelopeV1, { type: "control.transition" }>,
          keyof AgentActivityEnvelopeBase
        >
      | Omit<
          Extract<AgentActivityEnvelopeV1, { type: "turn.finalized" }>,
          keyof AgentActivityEnvelopeBase
        >,
    ref: AgentActivityIngressRef,
    attachmentBody?: string,
  ): Promise<{ postIds: string[]; activityChannelId: string }> => {
    let result: { postIds: string[]; activityChannelId: string } | undefined;
    await enqueue(async () => {
      result = await params.sink.append({
        envelope: {
          ...envelope,
          schemaVersion: 1,
          eventKey: agentActivityEventKey(ref),
          emittedAt: now().toISOString(),
          ref,
          redaction: { policy: "octogee-v1", appliedAt: "producer" },
          // SAFETY: the spread carries the caller's envelope and this literal fills every remaining required v1 field.
        } as AgentActivityEnvelopeV1,
        ...(attachmentBody === undefined ? {} : { attachmentBody }),
      });
    });
    if (!result) {
      throw new Error("activity sink completed without an acknowledgement");
    }
    if (binding && result.activityChannelId !== binding.activityChannelId) {
      throw new Error("activity sink changed the authoritative activity channel within a run");
    }
    return result;
  };

  const appendCompleted = async (
    itemId: string,
    kind: AgentActivityKind,
    status: CompletedStatus,
    body: string,
    summary: string,
  ): Promise<void> => {
    const previous = emittedVersions.get(itemId);
    if (previous?.body === body || (previous && !MUTABLE_SEMANTIC_KINDS.has(kind))) {
      return;
    }
    const semanticVersion = (previous?.version ?? 0) + 1;
    emittedVersions.set(itemId, { body, version: semanticVersion });
    ordinal += 1;
    const ref = refFor(itemId, ordinal, semanticVersion);
    const detailBytes = Buffer.byteLength(body, "utf8");
    if (detailBytes > maxAttachmentBytes) {
      throw new Error(`activity detail exceeds ${maxAttachmentBytes} bytes`);
    }
    if (detailBytes > inlineDetailLimitBytes) {
      const sha256 = createHash("sha256").update(body).digest("hex");
      await appendEnvelope(
        {
          type: "item.completed",
          item: {
            kind,
            status,
            summary,
            attachment: {
              filename: safeFilename(itemId),
              mediaType: "text/markdown",
              byteLength: detailBytes,
              sha256,
              multipartField: "detail",
            },
          },
        },
        ref,
        body,
      );
      return;
    }
    await appendEnvelope(
      {
        type: "item.completed",
        item: {
          kind,
          status,
          summary,
          detail: { format: "markdown", text: body },
        },
      },
      ref,
    );
  };

  const flushCommentary = async (): Promise<void> => {
    for (const [itemId, text] of commentary) {
      await appendCompleted(itemId, "commentary", "completed", text, text.slice(0, 4000));
    }
    commentary.clear();
  };

  const start = (): Promise<AgentActivityRunBinding> => {
    if (binding) {
      return Promise.resolve(binding);
    }
    if (startPromise) {
      return startPromise;
    }
    startPromise = (async () => {
      const ref = refFor("octogee:run-root", 0);
      const acknowledged = await appendEnvelope({ type: "turn.started" }, ref);
      const activityChannelId = acknowledged.activityChannelId.trim();
      const activityRootPostId = acknowledged.postIds[0]?.trim();
      if (!activityChannelId || acknowledged.postIds.length !== 1 || !activityRootPostId) {
        throw new Error("activity turn start requires one root post and an authoritative channel");
      }
      binding = { activityChannelId, activityRootPostId };
      return binding;
    })();
    return startPromise;
  };

  const onItemEvent = async (event: AgentActivityItemEvent): Promise<void> => {
    if (finalized || SKIPPED_KINDS.has(normalizeKind(event))) {
      return;
    }
    await start();
    fallbackIndex += 1;
    const itemId = normalizedItemId(event, fallbackIndex);
    const kind = normalizeKind(event);
    const rawText = eventText(event);
    if (!rawText) {
      return;
    }
    const redacted = redact(rawText);
    const body = THINKING_KINDS.has(kind) ? `**Thinking**\n\n${redacted}` : redacted;
    if (COMMENTARY_KINDS.has(kind)) {
      const previous = commentary.get(itemId) ?? "";
      if (body.length > previous.length) {
        commentary.set(itemId, body);
      }
      return;
    }
    await flushCommentary();
    const status = completedStatus(event);
    if (!status) {
      return;
    }
    await appendCompleted(itemId, activityKind(event), status, body, summaryForEvent(event, body));
  };

  const transitionApproval = async (transition: {
    approvalId: string;
    to: "approved" | "denied" | "expired";
    actorId: string;
  }): Promise<void> => {
    if (finalized) {
      return;
    }
    await start();
    const approvalId = normalize(transition.approvalId);
    const actorId = normalize(transition.actorId);
    if (!approvalId || !actorId) {
      throw new Error("activity approval transition requires approval and actor ids");
    }
    const itemId = `octogee:approval:${approvalId}`;
    const resolved = approvalTransitions.get(itemId);
    if (resolved) {
      if (resolved !== transition.to) {
        throw new Error(`activity approval ${approvalId} already resolved as ${resolved}`);
      }
      return;
    }
    const created = emittedVersions.get(itemId);
    if (!created) {
      throw new Error(`activity approval ${approvalId} was not published`);
    }
    approvalTransitions.set(itemId, transition.to);
    const semanticVersion = created.version + 1;
    emittedVersions.set(itemId, { body: transition.to, version: semanticVersion });
    ordinal += 1;
    const ref = refFor(itemId, ordinal, semanticVersion);
    await appendEnvelope(
      {
        type: "control.transition",
        control: { from: "waiting", to: transition.to, actorId },
      },
      ref,
    );
  };

  const finalize = async (outcome: "completed" | "failed" | "stopped"): Promise<void> => {
    if (finalized) {
      return;
    }
    await start();
    finalized = true;
    await flushCommentary();
    ordinal += 1;
    const ref = refFor("octogee:turn-finalized", ordinal);
    await appendEnvelope({ type: "turn.finalized", outcome }, ref);
    await chain;
  };

  return { start, onItemEvent, transitionApproval, finalize, binding: () => binding };
}
