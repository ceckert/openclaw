import { afterEach, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  invalidateSessionSharingSnapshot,
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("grants native channel access to synchronized members and revokes pending mutations and live reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const member = roleClient("none", "channel-member");
    const profileId = member.authenticatedUserProfile!.profileId;
    const sessionKey = "agent:main:mattermost:group:test-channel";
    const scope = { agentId: "main", sessionKey };
    const entry = {
      sessionId: "channel-session",
      updatedAt: 1,
      createdVia: "channel" as const,
      createdActor: { type: "human" as const, source: "channel" as const, id: "external-person" },
    };
    await upsertSessionEntryCore(scope, entry);
    const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
    const filter = createSessionListEntryFilter({ cfg, client: member })!;
    const request = (method: string) =>
      resolveSessionMutationAuthorization({
        client: member,
        method,
        requestParams: { sessionKey },
        context,
      });
    const event = () => canReceiveSessionEvent({ cfg, client: member, sessionKeys: [sessionKey] });
    expect(filter(sessionKey, entry)).toBe(false);
    expect(event()).toBe(false);
    expect(request("board.get").error).not.toBeNull();
    addSessionMember(scope, {
      identityId: profileId,
      addedBy: "channel-sync",
      expectedSessionId: entry.sessionId,
    });
    invalidateSessionSharingSnapshot(sessionKey);
    expect(filter(sessionKey, entry)).toBe(true);
    expect(event()).toBe(true);
    const target = resolveSessionSharingTarget({ cfg, sessionKey })!;
    expect(resolveSessionSharingRole({ cfg, client: member, target })).toBe("member");
    for (const method of [
      "board.get",
      "board.update",
      "tasks.list",
      "chat.metadata",
      "chat.send",
      "sessions.viewers.set",
      "sessions.messages.subscribe",
    ]) {
      expect(request(method).error, method).toBeNull();
    }
    const pending = request("board.update").authorization!;
    expect(() => pending.assertCurrent()).not.toThrow();
    removeSessionMember(scope, profileId, undefined, entry.sessionId);
    invalidateSessionSharingSnapshot(sessionKey);
    expect(filter(sessionKey, entry)).toBe(false);
    expect(event()).toBe(false);
    expect(request("board.get").error).not.toBeNull();
    expect(() => pending.assertCurrent()).toThrow();
  });
});

it.each(["draft", "incognito"] as const)(
  "keeps %s channels private despite explicit membership",
  async (privacy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const member = roleClient("none", `channel-${privacy}`);
      const sessionKey = `agent:main:mattermost:group:${privacy === "incognito" ? "incognito-" : ""}private`;
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: `channel-${privacy}`,
        updatedAt: 1,
        createdVia: "channel",
        ...(privacy === "incognito" ? { incognito: true } : { visibility: "draft" }),
      });
      const target = resolveSessionSharingTarget({ cfg, sessionKey })!;
      expect(target).not.toBeNull();
      addSessionMember(
        { ...scope, storePath: target.storePath },
        {
          identityId: member.authenticatedUserProfile!.profileId,
          addedBy: "channel-sync",
          expectedSessionId: target.entry.sessionId,
        },
      );
      invalidateSessionSharingSnapshot(sessionKey);
      expect(createSessionListEntryFilter({ cfg, client: member })!(sessionKey, target.entry)).toBe(
        false,
      );
      expect(canReceiveSessionEvent({ cfg, client: member, sessionKeys: [sessionKey] })).toBe(
        false,
      );
      expect(
        resolveSessionMutationAuthorization({
          client: member,
          method: "board.update",
          requestParams: { sessionKey },
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        }).error,
      ).not.toBeNull();
    });
  },
);
