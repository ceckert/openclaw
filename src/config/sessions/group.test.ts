// Session group tests cover grouping and lookup of related sessions.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { conversationRouteContextFromMsgContext } from "./conversation-route-context.js";
import { buildGroupDisplayTitle, resolveGroupSessionKey } from "./group.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

describe("resolveGroupSessionKey", () => {
  it("preserves Signal group ids from the originating target", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const ctx = {
      Provider: "signal",
      ChatType: "group",
      From: "signal:+15551234567",
      OriginatingTo: `signal:group:${mixedGroupId}`,
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: `signal:group:${mixedGroupId}`,
      channel: "signal",
      id: mixedGroupId,
      chatType: "group",
    });
  });

  it("keeps non-Signal group ids lowercase", () => {
    const ctx = {
      Provider: "telegram",
      ChatType: "group",
      From: "telegram:1234",
      OriginatingTo: "telegram:group:MiXeDGroup",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: "telegram:group:mixedgroup",
      channel: "telegram",
      id: "mixedgroup",
      chatType: "group",
    });
  });

  it("preserves empty opaque segments in originating group ids", () => {
    const ctx = {
      Provider: "matrix",
      ChatType: "channel",
      From: "matrix:channel:!room:[2001:db8::1]",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: "matrix:channel:!room:[2001:db8::1]",
      channel: "matrix",
      id: "!room:[2001:db8::1]",
      chatType: "channel",
    });
  });

  it("rejects empty structural group-route segments", () => {
    const ctx = {
      Provider: "telegram",
      ChatType: "group",
      From: "telegram::group:room",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toBeNull();
  });
});

describe("buildGroupDisplayTitle", () => {
  it("refreshes a Mattermost channel slug to its human subject while preserving team routing", () => {
    const key = "agent:main:mattermost:group:channel-id";
    const existing: SessionEntry = {
      sessionId: "channel-session",
      updatedAt: 1,
      chatType: "group",
      groupChannel: "#workspace-general",
      space: "opaque-team-id",
    };
    const ctx: MsgContext = {
      Provider: "mattermost",
      From: "mattermost:group:channel-id",
      ChatType: "group",
      ConversationRoutePeerId: "channel-id",
      GroupSubject: "General",
      GroupSpace: "opaque-team-id",
    };
    const updated = {
      ...existing,
      ...deriveSessionMetaPatch({ ctx, sessionKey: key, existing }),
    };

    expect(buildGroupDisplayTitle(existing)).toBe("opaque-team-id #workspace-general");
    expect(buildGroupDisplayTitle(updated)).toBe("General");
    expect(updated.groupChannel).toBeUndefined();
    expect(updated.space).toBe("opaque-team-id");
    expect(conversationRouteContextFromMsgContext(ctx)).toEqual({
      peerId: "channel-id",
      teamId: "opaque-team-id",
    });
  });

  it("prefers the native channel name with optional space prefix", () => {
    expect(buildGroupDisplayTitle({ groupChannel: "general" })).toBe("#general");
    expect(buildGroupDisplayTitle({ groupChannel: "#general", space: "Acme" })).toBe(
      "Acme #general",
    );
    expect(buildGroupDisplayTitle({ groupChannel: "general", subject: "Topic" })).toBe("#general");
  });

  it("falls back to the chat subject, then the space, then undefined", () => {
    expect(buildGroupDisplayTitle({ subject: "OpenClaw Devs" })).toBe("OpenClaw Devs");
    expect(buildGroupDisplayTitle({ space: "Acme" })).toBe("Acme");
    expect(buildGroupDisplayTitle({})).toBeUndefined();
    expect(buildGroupDisplayTitle({ subject: "  " })).toBeUndefined();
  });
});
