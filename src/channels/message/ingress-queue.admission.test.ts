import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-admission-"));
  try {
    return await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("channel ingress admission state", () => {
  it("uses monotonic revisions and retains canceled tombstones", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "mattermost",
        accountId: "admission",
        stateDir,
        now: () => 100,
      });

      await queue.enqueue("pending", { text: "remove me" });
      expect(await queue.inspect("pending")).toMatchObject({
        id: "pending",
        status: "pending",
        revision: 1,
      });
      expect(await queue.cancelPending("pending", { idempotencyKey: "remove:pending" })).toEqual({
        outcome: "canceled",
        revision: 2,
      });
      expect(await queue.cancelPending("pending", { idempotencyKey: "remove:pending" })).toEqual({
        outcome: "already-canceled",
        revision: 2,
      });
      expect(await queue.inspect("pending")).toMatchObject({
        id: "pending",
        status: "canceled",
        revision: 2,
        canceledMetadata: { idempotencyKey: "remove:pending" },
      });

      await queue.enqueue("claimed", { text: "started" });
      expect(await queue.claim("claimed", { ownerId: "worker" })).not.toBeNull();
      expect(await queue.cancelPending("claimed", { idempotencyKey: "remove:claimed" })).toEqual({
        outcome: "already-started",
        revision: 2,
      });
    });
  });

  it("updates pending admission metadata with a monotonic row revision", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }, { state: string }>({
        channelId: "mattermost",
        accountId: "admission",
        stateDir,
        now: () => 100,
      });
      await queue.enqueue("post-1", { text: "queued" }, { metadata: { state: "blocked" } });

      await expect(queue.annotatePending("post-1", { state: "queued" })).resolves.toMatchObject({
        status: "pending",
        revision: 2,
        metadata: { state: "queued" },
      });
      expect(await queue.claim("post-1")).not.toBeNull();
      await expect(queue.annotatePending("post-1", { state: "blocked" })).resolves.toBeNull();
    });
  });

  it("retains source payload through start and annotates terminal completion", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<
        { text: string },
        { turnId: string },
        { state: "started" | "completed"; runId: string }
      >({
        channelId: "mattermost",
        accountId: "admission",
        stateDir,
        now: () => 100,
      });
      await queue.enqueue("post-1", { text: "original" }, { metadata: { turnId: "post-1" } });
      const claim = await queue.claim("post-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected claim");
      }
      expect(
        await queue.complete(claim, {
          retainPayload: true,
          metadata: { state: "started", runId: "run-1" },
        }),
      ).toBe(true);
      expect(await queue.inspect("post-1")).toMatchObject({
        status: "completed",
        revision: 3,
        payload: { text: "original" },
        completedMetadata: { state: "started", runId: "run-1" },
      });
      expect(
        await queue.annotateCompleted("post-1", { state: "completed", runId: "run-1" }),
      ).toMatchObject({
        status: "completed",
        revision: 4,
        completedMetadata: { state: "completed", runId: "run-1" },
      });
      expect(await queue.listCompleted()).toEqual([
        expect.objectContaining({
          id: "post-1",
          metadata: { state: "completed", runId: "run-1" },
        }),
      ]);
    });
  });
});
