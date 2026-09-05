import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  listMessageReceiptPlatformIds,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";

export type MattermostTurnIdentity = {
  conversationId: string;
  turnId: string;
  agentId: string;
  sessionKey: string;
  origin: "human";
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId: string;
};

export type MattermostAnswerDeliveryOutcome =
  | "delivered"
  | "partial"
  | "failed"
  | "suppressed"
  | "not-attempted";

export type MattermostAnswerPart = {
  postId: string;
  kind: MessageReceiptPartKind;
  index: number;
  rootPostId?: string;
  threadId?: string;
};

type MattermostDeliveryEvent = {
  runId: string;
  agentId: string;
  sessionKey?: string;
  stream: "delivery";
  data: Record<string, unknown>;
};

type DeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  visibleReplySent?: boolean;
  suppression?: unknown;
};

type CollectedPart = Omit<MattermostAnswerPart, "index">;

function normalized(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function partsFromReceipt(receipt: MessageReceipt): CollectedPart[] {
  const receiptParts = new Map(
    receipt.parts.map((part) => [normalized(part.platformMessageId), part] as const),
  );
  const candidates = [
    ...listMessageReceiptPlatformIds(receipt),
    ...receipt.parts.map((part) => part.platformMessageId),
  ];
  const seen = new Set<string>();
  const parts: CollectedPart[] = [];
  for (const candidate of candidates) {
    const postId = normalized(candidate);
    if (!postId || seen.has(postId)) {
      continue;
    }
    seen.add(postId);
    const source = receiptParts.get(postId);
    const rootPostId = normalized(source?.replyToId) ?? normalized(receipt.replyToId);
    const threadId = normalized(source?.threadId) ?? normalized(receipt.threadId);
    parts.push({
      postId,
      kind: source?.kind ?? "unknown",
      ...(rootPostId ? { rootPostId } : {}),
      ...(threadId ? { threadId } : {}),
    });
  }
  return parts;
}

function partsFromResult(result: DeliveryResult | void): CollectedPart[] {
  if (result?.receipt) {
    return partsFromReceipt(result.receipt);
  }
  return (result?.messageIds ?? []).flatMap((candidate) => {
    const postId = normalized(candidate);
    return postId ? [{ postId, kind: "unknown" as const }] : [];
  });
}

function createReceiptTracker() {
  const partsByPostId = new Map<string, CollectedPart>();
  let observed = false;
  let suppressed = false;
  let failed = false;

  const addResult = (result: DeliveryResult | void): number => {
    const parts = partsFromResult(result);
    for (const part of parts) {
      const current = partsByPostId.get(part.postId);
      if (!current) {
        partsByPostId.set(part.postId, part);
        continue;
      }
      partsByPostId.set(part.postId, {
        ...current,
        ...(current.kind === "unknown" && part.kind !== "unknown" ? { kind: part.kind } : {}),
        ...(!current.rootPostId && part.rootPostId ? { rootPostId: part.rootPostId } : {}),
        ...(!current.threadId && part.threadId ? { threadId: part.threadId } : {}),
      });
    }
    return parts.length;
  };

  return {
    record(result: DeliveryResult | void): void {
      observed = true;
      if (addResult(result) > 0) {
        return;
      }
      if (result?.visibleReplySent === false || result?.suppression !== undefined) {
        suppressed = true;
      } else {
        failed = true;
      }
    },
    recordError(error: unknown): void {
      observed = true;
      failed = true;
      if (isChannelPartialDeliveryError(error)) {
        addResult(error.deliveryResult);
      }
    },
    recordFailed(result: DeliveryResult): void {
      observed = true;
      failed = true;
      addResult(result);
    },
    snapshot(): {
      deliveryOutcome: MattermostAnswerDeliveryOutcome;
      postIds: string[];
      parts: MattermostAnswerPart[];
    } {
      const parts = Array.from(partsByPostId.values(), (part, index): MattermostAnswerPart => {
        const indexedPart: MattermostAnswerPart = {
          postId: part.postId,
          kind: part.kind,
          index,
        };
        if (part.rootPostId) {
          indexedPart.rootPostId = part.rootPostId;
        }
        if (part.threadId) {
          indexedPart.threadId = part.threadId;
        }
        return indexedPart;
      });
      const deliveryOutcome: MattermostAnswerDeliveryOutcome = failed
        ? parts.length > 0
          ? "partial"
          : "failed"
        : parts.length > 0
          ? "delivered"
          : observed && suppressed
            ? "suppressed"
            : "not-attempted";
      return {
        deliveryOutcome,
        postIds: parts.map((part) => part.postId),
        parts,
      };
    },
  };
}

export function createMattermostAnswerCommitController(params: {
  identity: MattermostTurnIdentity;
  emit?: (event: MattermostDeliveryEvent) => void;
}) {
  const emit = params.emit ?? emitAgentEvent;
  const tracker = createReceiptTracker();
  let runId: string | undefined;
  let terminalOutcome: "completed" | "failed" | "stopped" | undefined;
  let pendingFinalDeliveries = 0;
  let dispatcherSettled = false;
  let committed = false;

  const publish = () => {
    if (
      committed ||
      !runId ||
      !terminalOutcome ||
      !dispatcherSettled ||
      pendingFinalDeliveries !== 0
    ) {
      return;
    }
    committed = true;
    const data = {
      schemaVersion: 1,
      kind: "answer-commit",
      ...params.identity,
      runId,
      terminalOutcome,
      ...tracker.snapshot(),
    };
    emit({
      runId,
      agentId: params.identity.agentId,
      sessionKey: params.identity.sessionKey,
      stream: "delivery",
      data,
    });
  };

  return {
    start(nextRunId: string): void {
      const normalizedRunId = normalized(nextRunId);
      if (!normalizedRunId || runId) {
        return;
      }
      runId = normalizedRunId;
      emit({
        runId,
        agentId: params.identity.agentId,
        sessionKey: params.identity.sessionKey,
        stream: "delivery",
        data: {
          schemaVersion: 1,
          kind: "mattermost-turn-binding",
          ...params.identity,
          runId,
        },
      });
    },
    beginFinalDelivery(): void {
      pendingFinalDeliveries += 1;
    },
    settleFinalDelivery(result: DeliveryResult | void): void {
      tracker.record(result);
      pendingFinalDeliveries = Math.max(0, pendingFinalDeliveries - 1);
      publish();
    },
    failFinalDelivery(error: unknown): void {
      tracker.recordError(error);
      pendingFinalDeliveries = Math.max(0, pendingFinalDeliveries - 1);
      publish();
    },
    failFinalDeliveryWithResult(result: DeliveryResult): void {
      tracker.recordFailed(result);
      pendingFinalDeliveries = Math.max(0, pendingFinalDeliveries - 1);
      publish();
    },
    terminal(outcome: "completed" | "failed"): void {
      terminalOutcome = outcome;
      publish();
    },
    settleQueuedDispatcher(): void {
      dispatcherSettled = true;
      publish();
    },
    settleDispatcher(): void {
      dispatcherSettled = true;
      terminalOutcome ??= "stopped";
      publish();
    },
  };
}
