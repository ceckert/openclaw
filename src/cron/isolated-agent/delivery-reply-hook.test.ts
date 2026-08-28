import { describe, expect, it } from "vitest";
import { buildCronDeliveryReplyPayloadSendingHook } from "./delivery-reply-hook.js";

describe("buildCronDeliveryReplyPayloadSendingHook", () => {
  it("derives an immutable scheduled observation from the final resolved delivery", () => {
    const delivery = {
      channel: "telegram",
      to: "123456",
      accountId: "telegram-account-1",
      threadId: "original-root-1",
    };

    const hook = buildCronDeliveryReplyPayloadSendingHook(
      {
        agentId: "main",
        runSessionKey: "agent:main:cron:shared-session",
        lifecycleRevision: "scheduled-invocation-1",
      },
      delivery,
    );
    delivery.to = "mutated-after-hook-build";

    expect(hook).toEqual({
      kind: "final",
      channel: "telegram",
      sessionKey: "agent:main:cron:shared-session",
      runId: "scheduled-invocation-1",
      context: {
        channelId: "telegram",
        agentId: "main",
        accountId: "telegram-account-1",
        conversationId: "123456",
        sessionKey: "agent:main:cron:shared-session",
        runId: "scheduled-invocation-1",
        run: {
          origin: "scheduled",
          scheduled: {
            invocationId: "scheduled-invocation-1",
            delivery: {
              kind: "chat",
              channel: "telegram",
              to: "123456",
              accountId: "telegram-account-1",
              threadId: "original-root-1",
            },
          },
        },
      },
    });
    expect(Object.isFrozen(hook.context.run)).toBe(true);
    expect(Object.isFrozen(hook.context.run?.scheduled?.delivery)).toBe(true);
  });

  it("keeps invocation identities distinct when the cron session is shared", () => {
    const makeHook = (lifecycleRevision: string) =>
      buildCronDeliveryReplyPayloadSendingHook(
        {
          agentId: "main",
          runSessionKey: "agent:main:cron:shared-session",
          lifecycleRevision,
        },
        { channel: "telegram", to: "123456" },
      );

    const first = makeHook("scheduled-invocation-1");
    const second = makeHook("scheduled-invocation-2");

    expect([first, second]).toMatchObject([
      {
        runId: "scheduled-invocation-1",
        sessionKey: "agent:main:cron:shared-session",
        context: {
          runId: "scheduled-invocation-1",
          run: { scheduled: { invocationId: "scheduled-invocation-1" } },
        },
      },
      {
        runId: "scheduled-invocation-2",
        sessionKey: "agent:main:cron:shared-session",
        context: {
          runId: "scheduled-invocation-2",
          run: { scheduled: { invocationId: "scheduled-invocation-2" } },
        },
      },
    ]);
  });
});
