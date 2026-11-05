import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

function monitor(accountId = "alice") {
  const cfg: OpenClawConfig = {
    agents: { entries: { alice: {}, bob: {} } },
    bindings: ["alice", "bob"].map((id) => ({
      agentId: id,
      match: { channel: "mattermost", accountId: id },
    })),
    channels: {
      mattermost: {
        replyToMode: "all",
        threadSessionScope: "channel",
        accounts: { alice: {}, bob: {} },
      },
    },
  };
  const core = createPluginRuntimeMock();
  core.channel.routing.resolveAgentRoute = resolveAgentRoute;
  return {
    cfg,
    core,
    account: resolveMattermostAccount({ cfg, accountId }),
    resources: { resolveChannelInfo: vi.fn() },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
}

describe("Mattermost channel session memory", () => {
  it.each(
    ["O", "P", "G"].flatMap((type) => [
      { type, existingThread: false },
      { type, existingThread: true },
    ]),
  )(
    "shares one $type channel session across roots (existing thread: $existingThread)",
    async ({ type, existingThread }) => {
      const context = monitor();
      const plans = await Promise.all(
        ["first-root", "second-root"].map((root) =>
          buildMattermostEventPlan(context, {
            channelId: "room",
            senderId: "member",
            postId: existingThread ? `reply-${root}` : root,
            threadRootId: existingThread ? root : undefined,
            channelInfo: { id: "room", type },
            dropLabel: "post",
          }),
        ),
      );
      const kind = type === "O" ? "channel" : "group";
      for (const [index, plan] of plans.entries()) {
        expect(plan?.finalizeContext({})).toMatchObject({
          SessionKey: `agent:alice:mattermost:${kind}:room`,
          ReplyToId: index === 0 ? "first-root" : "second-root",
          MessageThreadId: index === 0 ? "first-root" : "second-root",
          NativeChannelId: "room",
        });
        expect(plan?.thread.parentSessionKey).toBeUndefined();
      }
    },
  );

  it("keeps different channel and account-bound agent memories isolated", async () => {
    const plans = await Promise.all(
      [
        { accountId: "alice", channelId: "first" },
        { accountId: "alice", channelId: "second" },
        { accountId: "bob", channelId: "first" },
      ].map(({ accountId, channelId }) =>
        buildMattermostEventPlan(monitor(accountId), {
          channelId,
          senderId: "member",
          postId: "post",
          threadRootId: "root",
          channelInfo: { id: channelId, type: "P" },
          dropLabel: "post",
        }),
      ),
    );
    expect(plans.map((plan) => plan?.thread.sessionKey)).toEqual([
      "agent:alice:mattermost:group:first",
      "agent:alice:mattermost:group:second",
      "agent:bob:mattermost:group:first",
    ]);
  });
});
