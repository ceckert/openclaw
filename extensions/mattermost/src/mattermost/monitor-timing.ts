/**
 * Per-message latency timers for the Mattermost monitor.
 *
 * Emits one structured log line per delivered (or failed) reply with the
 * key pipeline spans so operators can diagnose inbound→reply latency
 * without having to flip OPENCLAW_LOG_LEVEL=debug and grep a dozen
 * internal landmarks. Runs at `info` level, one line per message.
 *
 * This module is pure — no I/O, no clock. The caller passes in
 * timestamps. All fields are public to keep the integration site in
 * `monitor.ts` readable.
 */

export type MessageTimingMarks = {
  wsReceivedAt: number;
  handleStartAt: number | null;
  typingSentAt: number | null;
  firstDraftAt: number | null;
  deliveredAt: number | null;
  batchedCount: number;
  summaryEmitted: boolean;
};

export type MessageTimingMarkField =
  | "handleStartAt"
  | "typingSentAt"
  | "firstDraftAt"
  | "deliveredAt";

export function createMessageTiming(opts: {
  wsReceivedAt: number;
  batchedCount?: number;
}): MessageTimingMarks {
  return {
    wsReceivedAt: opts.wsReceivedAt,
    handleStartAt: null,
    typingSentAt: null,
    firstDraftAt: null,
    deliveredAt: null,
    batchedCount: Math.max(1, opts.batchedCount ?? 1),
    summaryEmitted: false,
  };
}

/**
 * Set `field` to `now` only if it hasn't been set yet. Returns whether
 * the field was actually updated. Idempotent.
 */
export function markTimingOnce(
  t: MessageTimingMarks,
  field: MessageTimingMarkField,
  now: number,
): boolean {
  if (t[field] !== null) {
    return false;
  }
  t[field] = now;
  return true;
}

export function formatTimingSummary(
  t: MessageTimingMarks,
  opts: {
    channelId: string;
    postId: string | undefined;
    now: number;
    failedKind?: string;
  },
): string {
  const endAt = t.deliveredAt ?? opts.now;
  const total = endAt - t.wsReceivedAt;
  const parts: string[] = [];
  if (t.handleStartAt !== null) {
    parts.push(`ws→handle=${t.handleStartAt - t.wsReceivedAt}ms`);
  }
  if (t.handleStartAt !== null && t.typingSentAt !== null) {
    parts.push(`handle→typing=${t.typingSentAt - t.handleStartAt}ms`);
  }
  if (t.typingSentAt !== null && t.firstDraftAt !== null) {
    parts.push(`typing→first=${t.firstDraftAt - t.typingSentAt}ms`);
  } else if (
    t.handleStartAt !== null &&
    t.firstDraftAt !== null &&
    t.typingSentAt === null
  ) {
    parts.push(`handle→first=${t.firstDraftAt - t.handleStartAt}ms`);
  }
  if (t.firstDraftAt !== null && t.deliveredAt !== null) {
    parts.push(`first→delivered=${t.deliveredAt - t.firstDraftAt}ms`);
  }
  const postPart = opts.postId ? ` post=${opts.postId}` : "";
  const failedTag = opts.failedKind ? ` failed=${opts.failedKind}` : "";
  const batchTag = t.batchedCount > 1 ? ` batched=${t.batchedCount}` : "";
  const head = `[mm-timing] channel=${opts.channelId}${postPart} total=${total}ms${failedTag}${batchTag}`;
  if (parts.length === 0) {
    return head;
  }
  return `${head} | ${parts.join(" | ")}`;
}
