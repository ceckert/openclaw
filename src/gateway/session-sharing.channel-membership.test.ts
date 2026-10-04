import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  upsertSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  invalidateSessionSharingSnapshot,
  createSessionListEntryFilter,
  canReceiveSessionEvent,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  resolveSessionSharingRole,
} from "./session-sharing.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("retains channel provenance and revocation in prepared member authorization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:mattermost:group:prepared";
    const scope = { agentId: "main", sessionKey };
    replaceSessionEntrySync(scope, {
      sessionId: "channel",
      lifecycleRevision: "channel-generation",
      updatedAt: 1,
      createdVia: "channel",
      visibility: "shared",
    });
    addSessionMember(scope, { identityId: "requester", addedBy: "service" });
    const prepared = await prepareSessionMutationFacts({ cfg, ...scope });
    try {
      const client = sharingPolicyClient({ user: "requester" });
      const authorize = () =>
        authorizePreparedSessionMutation({ cfg, client, ...scope }, prepared.readCurrent(cfg), {
          policy: cfg.gateway!.roles!.definitions.none!,
          aliases: new Set(["requester"]),
        });
      expect(prepared.readCurrent(cfg).target.entry.createdVia).toBe("channel");
      expect(authorize()).toBeNull();
      removeSessionMember(scope, "requester");
      expect(authorize()?.message).toContain("was not found");
    } finally {
      prepared.release();
    }
  });
});

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
        requestParams:
          method === "sessions.messages.subscribe" ? { key: sessionKey } : { sessionKey },
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
    const channelTarget = resolveSessionSharingTarget({ cfg, sessionKey })!;
    expect(resolveSessionSharingRole({ cfg, client: member, target: channelTarget })).toBe(
      "member",
    );
    for (const method of [
      "board.get",
      "board.update",
      "chat.metadata",
      "chat.send",
      "sessions.viewers.set",
      "sessions.messages.subscribe",
    ]) {
      expect(request(method).error, method).toBeNull();
    }
    const pending = request("board.update").authorization!;
    expect(() => pending.assertCurrent()).not.toThrow();
    for (const archived of [true, false]) {
      expect(
        resolveSessionMutationAuthorization({
          client: member,
          method: "sessions.patch",
          requestParams: { key: sessionKey, archived },
          context,
        }).error,
      ).not.toBeNull();
    }
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
      const channelTarget = resolveSessionSharingTarget({ cfg, sessionKey })!;
      expect(channelTarget).not.toBeNull();
      addSessionMember(
        { ...scope, storePath: channelTarget.storePath },
        {
          identityId: member.authenticatedUserProfile!.profileId,
          addedBy: "channel-sync",
          expectedSessionId: channelTarget.entry.sessionId,
        },
      );
      invalidateSessionSharingSnapshot(sessionKey);
      expect(
        createSessionListEntryFilter({ cfg, client: member })!(sessionKey, channelTarget.entry),
      ).toBe(false);
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
