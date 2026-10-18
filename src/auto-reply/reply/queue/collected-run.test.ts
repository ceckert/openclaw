import { describe, expect, it } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../../test/helpers/channel-admission-evidence.js";
import { createChannelAdmissionAudit } from "../../../channels/message-access/admission-evidence.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../command-sender-authority.js";
import { enqueueFollowupRun } from "../queue.js";
import {
  createDrainRecorder,
  createQueueSettings,
  createQueueTestRun,
  drainRecordedQueue,
} from "../queue.test-helpers.js";
import { resolveCollectedRun } from "./collected-run.js";

describe("collected sender authority", () => {
  it.each([
    ["profile-guest", "profile-owner"],
    [undefined, "profile-owner"],
    ["profile-owner", undefined],
  ])(
    "splits unknown-participant batches for browser profiles %s and %s",
    async (first, second) => {
      const key = `test-collect-profile-split-${Date.now()}`;
      const { calls, done, runFollowup } = createDrainRecorder(2);
      const settings = createQueueSettings();
      for (const profile of [first, second]) {
        const item = createQueueTestRun({
          prompt: profile ?? "anonymous",
          originatingChannel: "webchat",
        });
        item.run = withCommandSenderAuthority(
          item.run,
          profile ? () => ({ profileId: profile }) : undefined,
        );
        enqueueFollowupRun(key, item, settings);
      }
      await drainRecordedQueue(key, runFollowup, done);
      expect(calls.map((call) => getCommandSenderAuthority(call.run)?.()?.profileId)).toEqual([
        first,
        second,
      ]);
    },
    3_000,
  );

  it.each([true, false])(
    "preserves the live binding only for the same verified person: %s",
    (samePerson) => {
      const audit = createChannelAdmissionAudit({ enabled: true });
      try {
        let active = true;
        const authority = () => (active ? { profileId: "profile-owner" } : undefined);
        const items = ["person-one", samePerson ? "person-one" : "person-two"].map(
          (participantId) => {
            const item = createQueueTestRun({ prompt: "queued turn" });
            item.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
              audit,
              channelId: "slack",
              participantId,
            });
            item.run = withCommandSenderAuthority(item.run, authority);
            return item;
          },
        );
        const collected = resolveCollectedRun(items, items[1]!.run);
        expect(getCommandSenderAuthority(collected)).toBe(samePerson ? authority : undefined);
        active = false;
        expect(getCommandSenderAuthority(collected)?.()).toBeUndefined();
      } finally {
        audit.close();
      }
    },
  );
});
