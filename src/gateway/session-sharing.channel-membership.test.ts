import { afterEach, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  upsertSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "./session-sharing-read.js";
import { canReceiveSessionEvent, resolveSessionSharingTargetAsync } from "./session-sharing.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const authorizationReleases: Array<() => void> = [];

afterEach(() => {
  for (const release of authorizationReleases.splice(0)) {
    release();
  }
  closeOpenClawAgentDatabasesForTest();
});

async function captureMutationAuthorization(
  params: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0],
) {
  const result = await resolveSessionMutationAuthorizationAsync(params);
  if (result.authorization?.release) {
    authorizationReleases.push(result.authorization.release);
  }
  return result;
}

async function prepareChannelAccess(params: {
  cfg: OpenClawConfig;
  client: GatewayClient;
  agentId: string;
  sessionKey: string;
}) {
  const prepared = await prepareSessionMutationFacts(params);
  try {
    const profiles = await prepareSessionSharingProfiles(params.client);
    return {
      [Symbol.dispose]: prepared.release,
      read() {
        const { target, membership } = prepared.readCurrent(params.cfg);
        const resolveTarget = (key: string) => (key === params.sessionKey ? target : null);
        const sharing = prepareProjectedSessionSharing({
          ...params,
          profiles,
          isMember: (selected, identityId) =>
            selected.storePath === target.storePath &&
            selected.storeKey === target.storeKey &&
            membership.has(identityId),
          resolveTarget,
        });
        return {
          listed: sharing.entryFilter?.(params.sessionKey, target.entry) ?? true,
          receives: canReceiveSessionEvent({
            ...params,
            sessionKeys: [params.sessionKey],
            prepared: { sharing, target: resolveTarget },
          }),
          role: sharing.roleForTarget(target),
        };
      },
    };
  } catch (error) {
    prepared.release();
    throw error;
  }
}

it("retains channel provenance and revocation in prepared member authorization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const sessionKey = "agent:main:mattermost:group:prepared";
    const scope = { agentId: "main", sessionKey };
    replaceSessionEntrySync(scope, {
      sessionId: "channel",
      lifecycleRevision: "channel-generation",
      updatedAt: 1,
      createdVia: "channel",
      visibility: "shared",
    });
    await addSessionMember(scope, { identityId: "requester", addedBy: "service" });
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
      await removeSessionMember(scope, "requester");
      expect(authorize()?.message).toContain("was not found");
    } finally {
      prepared.release();
    }
  });
});

it("grants native channel access to synchronized members and revokes pending mutations and live reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = rolePolicyConfig();
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
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
    using access = await prepareChannelAccess({ cfg, client: member, ...scope });
    const request = (method: string) =>
      captureMutationAuthorization({
        client: member,
        method,
        requestParams:
          method === "sessions.messages.subscribe" ? { key: sessionKey } : { sessionKey },
        context,
      });
    expect(access.read()).toEqual({ listed: false, receives: false, role: "viewer" });
    expect((await request("board.get")).error).not.toBeNull();
    await addSessionMember(scope, {
      identityId: profileId,
      addedBy: "channel-sync",
      expectedSessionId: entry.sessionId,
    });
    expect(access.read()).toEqual({ listed: true, receives: true, role: "member" });
    for (const method of [
      "board.get",
      "board.update",
      "chat.metadata",
      "chat.send",
      "sessions.viewers.set",
      "sessions.messages.subscribe",
    ]) {
      expect((await request(method)).error, method).toBeNull();
    }
    const pending = (await request("board.update")).authorization!;
    expect(() => pending.assertCurrent()).not.toThrow();
    for (const archived of [true, false]) {
      expect(
        (
          await captureMutationAuthorization({
            client: member,
            method: "sessions.patch",
            requestParams: { key: sessionKey, archived },
            context,
          })
        ).error,
      ).not.toBeNull();
    }
    await removeSessionMember(scope, profileId, undefined, entry.sessionId);
    expect(access.read()).toEqual({ listed: false, receives: false, role: "viewer" });
    expect((await request("board.get")).error).not.toBeNull();
    expect(() => pending.assertCurrent()).toThrow();
  });
});

it.each(["draft", "incognito"] as const)(
  "keeps %s channels private despite explicit membership",
  async (privacy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const member = roleClient("none", `channel-${privacy}`);
      const sessionKey = `agent:main:mattermost:group:${privacy === "incognito" ? "incognito-" : ""}private`;
      const scope = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(scope, {
        sessionId: `channel-${privacy}`,
        updatedAt: 1,
        createdVia: "channel",
        ...(privacy === "incognito" ? { incognito: true } : { visibility: "draft" }),
      });
      const channelTarget = (await resolveSessionSharingTargetAsync({ cfg, sessionKey }))!;
      expect(channelTarget).not.toBeNull();
      await addSessionMember(
        { ...scope, storePath: channelTarget.storePath },
        {
          identityId: member.authenticatedUserProfile!.profileId,
          addedBy: "channel-sync",
          expectedSessionId: channelTarget.entry.sessionId,
        },
      );
      using access = await prepareChannelAccess({ cfg, client: member, ...scope });
      expect(access.read()).toEqual({
        listed: false,
        receives: false,
        role: "viewer",
      });
      expect(
        (
          await captureMutationAuthorization({
            client: member,
            method: "board.update",
            requestParams: { sessionKey },
            context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
          })
        ).error,
      ).not.toBeNull();
    });
  },
);
