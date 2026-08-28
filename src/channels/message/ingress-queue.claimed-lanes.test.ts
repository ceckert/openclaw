import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

function createTestIngressQueue(stateDir: string, now: () => number) {
  return createChannelIngressQueue<{ text: string }>({
    channelId: "test",
    accountId: "account",
    stateDir,
    now,
  });
}

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-queue-lanes-"));
  try {
    await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("channel ingress queue claimed lanes", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("atomically blocks a claimed lane across queue instances", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const now = () => clock++;
      const firstQueue = createTestIngressQueue(stateDir, now);
      const secondQueue = createTestIngressQueue(stateDir, now);

      await firstQueue.enqueue("a", { text: "first" }, { laneKey: "shared", receivedAt: 1 });
      await firstQueue.enqueue("b", { text: "second" }, { laneKey: "shared", receivedAt: 2 });
      expect(await Promise.all([firstQueue.listClaims(), secondQueue.listClaims()])).toEqual([
        [],
        [],
      ]);

      const claims = await Promise.all([
        firstQueue.claimNext({ ownerId: "first", blockClaimedLanes: true }),
        secondQueue.claimNext({ ownerId: "second", blockClaimedLanes: true }),
      ]);

      expect(claims.filter((claim) => claim !== null).map((claim) => claim.id)).toEqual(["a"]);
      expect((await firstQueue.listPending()).map((record) => record.id)).toEqual(["b"]);
    });
  });

  it("allows another queue instance to claim an independent lane", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const now = () => clock++;
      const firstQueue = createTestIngressQueue(stateDir, now);
      const secondQueue = createTestIngressQueue(stateDir, now);

      await firstQueue.enqueue("a", { text: "first" }, { laneKey: "shared", receivedAt: 1 });
      await firstQueue.enqueue("b", { text: "second" }, { laneKey: "shared", receivedAt: 2 });
      await firstQueue.enqueue("c", { text: "independent" }, { laneKey: "other", receivedAt: 3 });

      const claims = await Promise.all([
        firstQueue.claimNext({ ownerId: "first", blockClaimedLanes: true }),
        secondQueue.claimNext({ ownerId: "second", blockClaimedLanes: true }),
      ]);

      expect(
        claims
          .filter((claim) => claim !== null)
          .map((claim) => claim.id)
          .toSorted(),
      ).toEqual(["a", "c"]);
      expect((await firstQueue.listPending()).map((record) => record.id)).toEqual(["b"]);
    });
  });
});
