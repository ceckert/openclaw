import { describe, it, expect } from "vitest";
import {
  createMessageTiming,
  formatTimingSummary,
  markTimingOnce,
} from "./monitor-timing.js";

describe("createMessageTiming", () => {
  it("initializes all marks null except wsReceivedAt + batchedCount", () => {
    const t = createMessageTiming({ wsReceivedAt: 1000 });
    expect(t).toMatchObject({
      wsReceivedAt: 1000,
      handleStartAt: null,
      typingSentAt: null,
      firstDraftAt: null,
      deliveredAt: null,
      batchedCount: 1,
      summaryEmitted: false,
    });
  });

  it("clamps batchedCount to at least 1", () => {
    const t = createMessageTiming({ wsReceivedAt: 0, batchedCount: 0 });
    expect(t.batchedCount).toBe(1);
  });

  it("honors provided batchedCount when greater than 1", () => {
    const t = createMessageTiming({ wsReceivedAt: 0, batchedCount: 3 });
    expect(t.batchedCount).toBe(3);
  });
});

describe("markTimingOnce", () => {
  it("sets the field on first call and returns true", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    expect(markTimingOnce(t, "handleStartAt", 100)).toBe(true);
    expect(t.handleStartAt).toBe(100);
  });

  it("is a no-op on second call and returns false", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "handleStartAt", 100);
    expect(markTimingOnce(t, "handleStartAt", 200)).toBe(false);
    expect(t.handleStartAt).toBe(100);
  });
});

describe("formatTimingSummary", () => {
  it("emits full pipeline line when all marks present", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "handleStartAt", 100);
    markTimingOnce(t, "typingSentAt", 150);
    markTimingOnce(t, "firstDraftAt", 7500);
    markTimingOnce(t, "deliveredAt", 19000);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: "post-1",
      now: 19000,
    });
    expect(line).toBe(
      "[mm-timing] channel=chan-x post=post-1 total=19000ms | ws→handle=100ms | handle→typing=50ms | typing→first=7350ms | first→delivered=11500ms",
    );
  });

  it("omits stages that were never marked (early-exit path)", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "handleStartAt", 100);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: "post-1",
      now: 15000,
      failedKind: "group",
    });
    expect(line).toBe(
      "[mm-timing] channel=chan-x post=post-1 total=15000ms failed=group | ws→handle=100ms",
    );
  });

  it("includes batched tag when more than one post was debounced", () => {
    const t = createMessageTiming({ wsReceivedAt: 0, batchedCount: 3 });
    markTimingOnce(t, "handleStartAt", 100);
    markTimingOnce(t, "typingSentAt", 150);
    markTimingOnce(t, "firstDraftAt", 7500);
    markTimingOnce(t, "deliveredAt", 19000);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: "post-z",
      now: 19000,
    });
    expect(line).toContain(" batched=3");
    expect(line).toMatch(/batched=3 \| /);
  });

  it("handles missing postId gracefully", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "deliveredAt", 100);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: undefined,
      now: 100,
    });
    expect(line).toBe("[mm-timing] channel=chan-x total=100ms");
  });

  it("falls back to handle→first when typing was never marked", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "handleStartAt", 100);
    markTimingOnce(t, "firstDraftAt", 5000);
    markTimingOnce(t, "deliveredAt", 9000);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: "post-1",
      now: 9000,
    });
    expect(line).toContain("handle→first=4900ms");
    expect(line).not.toContain("handle→typing=");
    expect(line).not.toContain("typing→first=");
  });

  it("uses opts.now when deliveredAt was never marked (totals to error path)", () => {
    const t = createMessageTiming({ wsReceivedAt: 0 });
    markTimingOnce(t, "handleStartAt", 100);
    const line = formatTimingSummary(t, {
      channelId: "chan-x",
      postId: "post-1",
      now: 5000,
      failedKind: "direct",
    });
    expect(line).toContain("total=5000ms");
    expect(line).toContain("failed=direct");
  });
});
