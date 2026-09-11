import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
} from "../../config/sessions/session-sharing-store.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { resolveSessionSharingTarget } from "../session-sharing.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import {
  identifiedClient,
  sessionSharingTestContext,
  soloClient,
} from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("materializes canonical channels, reconciles membership idempotently, and preserves existing metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("channel-reader@example.com");
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const context = sessionSharingTestContext(vi.fn(), { agents: { list: [{ id: "main" }] } });
    const params = {
      agentId: "main",
      channel: "mattermost",
      peerKind: "group",
      peerId: "general",
      profileId: profile.id,
      member: true,
      displayName: "General",
    };
    const key = "agent:main:mattermost:group:general";
    const scope = { agentId: "main", sessionKey: key };
    const call = async (patch: Record<string, unknown> = {}) => {
      const responses: Parameters<RespondFn>[] = [];
      await sessionSharingHandlers["sessions.channel.sync"]?.({
        params: { ...params, ...patch },
        client,
        context,
        respond: (...args: Parameters<RespondFn>) => responses.push(args),
      } as never);
      return responses[0];
    };
    expect(await call({ member: false })).toEqual([true, { key, changed: false }, undefined]);
    expect(loadSessionEntry(scope)).toBeUndefined();
    const created = await call();
    expect(created?.[0]).toBe(true);
    const entry = loadSessionEntry(scope)!;
    expect(entry).toMatchObject({
      createdVia: "channel",
      displayName: "General",
      chatType: "group",
    });
    expect(entry.createdActor).toBeUndefined();
    expect(created?.[1]).toEqual({ key, sessionId: entry.sessionId, changed: true });
    expect(listSessionMembers(scope).map((row) => row.identityId)).toEqual([profile.id]);
    expect(await call({ displayName: "Changed" })).toEqual([
      true,
      { key, sessionId: entry.sessionId, changed: false },
      undefined,
    ]);
    expect(loadSessionEntry(scope)).toEqual(entry);
    expect(await call({ member: false })).toEqual([
      true,
      { key, sessionId: entry.sessionId, changed: true },
      undefined,
    ]);
    expect(listSessionMembers(scope)).toEqual([]);
    expect(await call({ member: false })).toEqual([
      true,
      { key, sessionId: entry.sessionId, changed: false },
      undefined,
    ]);
    client.connect.scopes = ["operator.write"];
    expect((await call())?.[0]).toBe(false);
    client.connect.scopes = ["operator.admin"];
    expect((await call({ peerId: "other:session" }))?.[0]).toBe(false);
    expect((await call({ agentId: "missing" }))?.[0]).toBe(false);
    expect((await call({ profileId: "missing" }))?.[0]).toBe(false);
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:mattermost:group:operator-session" },
      { sessionId: "operator", updatedAt: 1, createdVia: "operator" },
    );
    expect((await call({ peerId: "operator-session" }))?.[0]).toBe(false);
    expect(listSessionMembers(scope)).toEqual([]);
    addSessionMember(scope, {
      identityId: profile.id,
      addedBy: "native-owner",
      addedAt: 123,
      expectedSessionId: entry.sessionId,
    });
    const explicitGrant = listSessionMembers(scope);
    expect(await call()).toEqual([
      true,
      { key, sessionId: entry.sessionId, changed: false },
      undefined,
    ]);
    expect(await call({ member: false })).toEqual([
      true,
      { key, sessionId: entry.sessionId, changed: false },
      undefined,
    ]);
    expect(listSessionMembers(scope)).toEqual(explicitGrant);
  });
});

it("classifies channel synchronization as administrator-only", () => {
  expect(
    authorizeOperatorScopesForMethod("sessions.channel.sync", ["operator.read", "operator.write"]),
  ).toEqual({ allowed: false, missingScope: "operator.admin" });
  expect(authorizeOperatorScopesForMethod("sessions.channel.sync", ["operator.admin"])).toEqual({
    allowed: true,
  });
});

it("rechecks administrator authority after a queued lifecycle fence", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    const profile = ensureProfileForEmail("queued-channel-reader@example.com");
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const key = "agent:main:mattermost:group:queued";
    const scope = { agentId: "main", sessionKey: key };
    await upsertSessionEntryCore(scope, {
      sessionId: "queued-session",
      updatedAt: 1,
      createdVia: "channel",
    });
    const target = resolveSessionSharingTarget({ cfg, sessionKey: key })!;
    const entered = createDeferred();
    const release = createDeferred();
    const fence = runExclusiveSessionLifecycleMutation({
      scope: target.storePath,
      identities: [key, target.entry.sessionId],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const respond = vi.fn();
    const pending = sessionSharingHandlers["sessions.channel.sync"]!({
      params: {
        agentId: "main",
        channel: "mattermost",
        peerKind: "group",
        peerId: "queued",
        profileId: profile.id,
        member: true,
      },
      client,
      context: sessionSharingTestContext(vi.fn(), cfg),
      respond,
    } as never);
    client.connect.scopes = ["operator.write"];
    const rejected = expect(pending).rejects.toThrow(
      "operator.admin required at channel synchronization commit",
    );
    release.resolve();
    await fence;
    await rejected;
    expect(respond).not.toHaveBeenCalled();
    expect(listSessionMembers(scope)).toEqual([]);
  });
});

it.each(["provider", "chatType", "nativeChannelId"] as const)(
  "rejects contradictory %s provenance without changing members",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { list: [{ id: "main" }] } };
      const profile = ensureProfileForEmail("provenance-reader@example.com");
      const client = soloClient();
      client.connect.scopes = ["operator.admin"];
      const key = "agent:main:mattermost:group:general";
      const scope = { agentId: "main", sessionKey: key };
      await upsertSessionEntryCore(scope, {
        sessionId: "channel-provenance",
        updatedAt: 1,
        createdVia: "channel",
        delivery: {
          kind: "external",
          route: { channel: "mattermost", target: { to: "channel:general", chatType: "group" } },
          context: { channel: "mattermost", to: "channel:general" },
          origin: {
            provider: field === "provider" ? "another-channel" : "mattermost",
            chatType: field === "chatType" ? "direct" : "group",
            nativeChannelId: field === "nativeChannelId" ? "other" : "general",
          },
        },
      });
      const entry = loadSessionEntry(scope);
      const respond = vi.fn();
      await sessionSharingHandlers["sessions.channel.sync"]!({
        params: {
          agentId: "main",
          channel: "mattermost",
          peerKind: "group",
          peerId: "general",
          profileId: profile.id,
          member: true,
        },
        client,
        context: sessionSharingTestContext(vi.fn(), cfg),
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(listSessionMembers(scope)).toEqual([]);
      expect(loadSessionEntry(scope)).toEqual(entry);
    });
  },
);

it("preserves an explicit owner grant made after channel synchronization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    const profile = ensureProfileForEmail("transferred-channel-reader@example.com");
    const owner = ensureProfileForEmail("channel-owner@example.com");
    const serviceClient = soloClient();
    serviceClient.connect.scopes = ["operator.admin"];
    const key = "agent:main:mattermost:group:general";
    const scope = { agentId: "main", sessionKey: key };
    await upsertSessionEntryCore(scope, {
      sessionId: "channel-owner",
      updatedAt: 1,
      createdVia: "channel",
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const context = sessionSharingTestContext(vi.fn(), cfg);
    const sync = async (member: boolean) => {
      const respond = vi.fn();
      await sessionSharingHandlers["sessions.channel.sync"]!({
        params: {
          agentId: "main",
          channel: "mattermost",
          peerKind: "group",
          peerId: "general",
          profileId: profile.id,
          member,
        },
        client: serviceClient,
        context,
        respond,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };
    await sync(true);
    const initial = listSessionMembers(scope);
    expect(initial[0]?.addedBy).not.toBe(owner.id);
    const grant = async () => {
      const respond = vi.fn();
      await sessionSharingHandlers["session.members.add"]!({
        params: { sessionKey: key, identityId: profile.id },
        client: identifiedClient(owner.id),
        context,
        respond,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };
    await grant();
    const explicit = listSessionMembers(scope);
    expect(explicit[0]?.addedBy).toBe(owner.id);
    await grant();
    expect(listSessionMembers(scope)).toEqual(explicit);
    await sync(true);
    expect(listSessionMembers(scope)).toEqual(explicit);
    await sync(false);
    expect(listSessionMembers(scope)).toEqual(explicit);
  });
});
