import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  loadSessionEntry,
  recordInboundSessionMeta,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
} from "../../config/sessions/session-sharing-store.js";
import * as sessionLifecycle from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { prepareChannelSessionTarget } from "./sessions-channel-target.js";
import {
  callSessionSharingHandler,
  identifiedClient,
  sessionSharingTestContext,
  soloClient,
} from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

it.each(["group", "channel"] as const)(
  "synchronizes only the selected Mattermost %s thread and preserves independent owner grants",
  async (peerKind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
      const audience = ensureProfileForEmail("thread-audience@example.test");
      const granted = ensureProfileForEmail("thread-granted@example.test");
      const owner = ensureProfileForEmail("thread-owner@example.test");
      const peerId = "c".repeat(26);
      const root = "r".repeat(26);
      const baseKey = `agent:main:mattermost:${peerKind}:${peerId}`;
      const key = `${baseKey}:thread:${root}`;
      const scope = { agentId: "main", sessionKey: key };
      const siblings = [baseKey, `${baseKey}:thread:${"s".repeat(26)}`];
      for (const sessionKey of [key, ...siblings]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey === key ? "selected-thread" : sessionKey,
            updatedAt: 1,
            createdVia: "channel",
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
      }
      const entry = loadSessionEntry(scope);
      const client = soloClient();
      client.connect.scopes = ["operator.admin"];
      const context = sessionSharingTestContext(vi.fn(), cfg);
      const sync = async (profileId: string, member: boolean) => {
        const respond = vi.fn();
        await coreGatewayHandlers["sessions.channel.sync"]!({
          params: {
            agentId: "main",
            channel: "mattermost",
            peerKind,
            peerId,
            threadRootPostId: root,
            profileId,
            member,
          },
          client,
          context,
          respond,
        } as never);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ key, sessionId: "selected-thread" });
      };
      await sync(audience.id, true);
      await sync(granted.id, true);
      const explicit = await callSessionSharingHandler(
        "session.members.add",
        { sessionKey: key, identityId: granted.id },
        context,
        identifiedClient(owner.id),
      );
      expect(explicit[0]?.[0]).toBe(true);
      await sync(audience.id, false);
      await sync(granted.id, false);
      const members = await callSessionSharingHandler(
        "session.members.listEvidence",
        { sessionKey: key },
        context,
        identifiedClient(owner.id),
      );
      expect(members[0]?.[0]).toBe(true);
      expect(members[0]?.[1]).toMatchObject({
        members: [{ identityId: granted.id, addedBy: owner.id }],
      });
      expect((await readSessionMembersInWorker(scope)).members).toHaveLength(1);
      expect(loadSessionEntry(scope)).toEqual(entry);
      for (const sessionKey of siblings) {
        expect((await readSessionMembersInWorker({ agentId: "main", sessionKey })).members).toEqual(
          [],
        );
      }
    });
  },
);

it.each(["group", "channel"] as const)(
  "synchronizes channel-wide %s membership after inbound replies change delivery roots",
  async (peerKind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
      const profile = ensureProfileForEmail("channel-wide-reader@example.test");
      const peerId = "c".repeat(26);
      const key = `agent:main:mattermost:${peerKind}:${peerId}`;
      const scope = { agentId: "main", sessionKey: key };
      const client = soloClient();
      client.connect.scopes = ["operator.admin"];
      const context = sessionSharingTestContext(vi.fn(), cfg);
      const sync = async (member: boolean, changed: boolean) => {
        const respond = vi.fn();
        await coreGatewayHandlers["sessions.channel.sync"]!({
          params: {
            agentId: "main",
            channel: "mattermost",
            peerKind,
            peerId,
            profileId: profile.id,
            member,
          },
          client,
          context,
          respond,
        } as never);
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          { key, sessionId: expect.any(String), changed },
          undefined,
        );
      };
      await sync(true, true);
      const { storePath } = await prepareChannelSessionTarget({ cfg, key, agentId: "main" });
      const sessionId = loadSessionEntry(scope)?.sessionId;
      for (const root of ["r".repeat(26), "s".repeat(26)]) {
        await recordInboundSessionMeta({
          storePath,
          sessionKey: key,
          ctx: {
            Provider: "mattermost",
            Surface: "mattermost",
            ChatType: peerKind,
            From: `mattermost:${peerKind}:${peerId}`,
            To: `channel:${peerId}`,
            SessionKey: key,
            MessageThreadId: root,
            NativeChannelId: peerId,
            InboundAccessAuthorized: true,
            OriginatingChannel: "mattermost",
            OriginatingTo: `channel:${peerId}`,
          },
        });
        const entry = loadSessionEntry(scope);
        expect(entry).toMatchObject({
          sessionId,
          createdVia: "channel",
          delivery: {
            kind: "external",
            origin: {
              provider: "mattermost",
              chatType: peerKind,
              nativeChannelId: peerId,
              threadId: root,
            },
          },
        });
        await sync(true, false);
        expect(loadSessionEntry(scope)).toEqual(entry);
        expect(loadSessionEntry({ ...scope, sessionKey: `${key}:thread:${root}` })).toBeUndefined();
      }
      const entry = loadSessionEntry(scope);
      await sync(false, true);
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
      expect(loadSessionEntry(scope)).toEqual(entry);
    });
  },
);

it.each([
  { threadRootPostId: "short" },
  { threadRootPostId: `${"r".repeat(26)}:thread:other` },
  { threadRootPostId: "R".repeat(26) },
  { threadRootPostId: "r".repeat(26), channel: "other" },
  { threadRootPostId: "r".repeat(26), peerKind: "direct" },
  { threadRootPostId: "r".repeat(26), peerId: "general" },
])("rejects a forged Mattermost thread target %j", async (patch) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const profile = ensureProfileForEmail("invalid-thread@example.test");
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const respond = vi.fn();
    await coreGatewayHandlers["sessions.channel.sync"]!({
      params: {
        agentId: "main",
        channel: "mattermost",
        peerKind: "channel",
        peerId: "c".repeat(26),
        profileId: profile.id,
        member: true,
        ...patch,
      },
      client,
      context: sessionSharingTestContext(vi.fn(), cfg),
      respond,
    } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:mattermost:channel:${"c".repeat(26)}:thread:${"r".repeat(26)}`,
      }),
    ).toBeUndefined();
  });
});

it("rejects a thread whose canonical native delivery names a different root", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const peerId = "c".repeat(26);
    const root = "r".repeat(26);
    const scope = {
      agentId: "main",
      sessionKey: `agent:main:mattermost:channel:${peerId}:thread:${root}`,
    };
    const profile = ensureProfileForEmail("contradictory-thread@example.test");
    await upsertSessionEntryCore(scope, {
      sessionId: "thread-provenance",
      updatedAt: 1,
      createdVia: "channel",
      delivery: {
        kind: "external",
        route: {
          channel: "mattermost",
          target: { to: `channel:${peerId}`, chatType: "channel" },
          thread: { id: "s".repeat(26) },
        },
        context: { channel: "mattermost", to: `channel:${peerId}`, threadId: "s".repeat(26) },
        origin: {
          provider: "mattermost",
          chatType: "channel",
          nativeChannelId: peerId,
          threadId: "s".repeat(26),
        },
      },
    });
    const entry = loadSessionEntry(scope);
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const respond = vi.fn();
    await coreGatewayHandlers["sessions.channel.sync"]!({
      params: {
        agentId: "main",
        channel: "mattermost",
        peerKind: "channel",
        peerId,
        threadRootPostId: root,
        profileId: profile.id,
        member: true,
      },
      client,
      context: sessionSharingTestContext(vi.fn(), cfg),
      respond,
    } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(loadSessionEntry(scope)).toEqual(entry);
    expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
  });
});

it("bootstraps an unopened missing agent database before creating its channel", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "cold-channel";
    const key = `agent:${agentId}:mattermost:group:general`;
    const scope = { agentId, sessionKey: key };
    const profile = ensureProfileForEmail("cold-channel-reader@example.test");
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const storePath = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(getOpenClawAgentDatabaseIfOpen(scope)).toBeUndefined();
    const respond = vi.fn();
    await coreGatewayHandlers["sessions.channel.sync"]!({
      params: {
        agentId,
        channel: "mattermost",
        peerKind: "group",
        peerId: "general",
        profileId: profile.id,
        member: true,
      },
      client,
      context: sessionSharingTestContext(vi.fn(), { agents: { entries: { [agentId]: {} } } }),
      respond,
    } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { key, sessionId: expect.any(String), changed: true },
      undefined,
    );
    expect(fs.existsSync(storePath)).toBe(true);
    expect(loadSessionEntry(scope)).toMatchObject({ createdVia: "channel", chatType: "group" });
    expect(
      (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
    ).toEqual([profile.id]);
  });
});

it("materializes canonical channels, reconciles membership idempotently, and preserves existing metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const profile = ensureProfileForEmail("channel-reader@example.com");
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const context = sessionSharingTestContext(vi.fn(), cfg);
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
      const sql = observeHostDataSql();
      try {
        await coreGatewayHandlers["sessions.channel.sync"]!({
          params: { ...params, ...patch },
          client,
          context,
          respond: (...args: Parameters<RespondFn>) => responses.push(args),
        } as never);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
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
    expect((await readSessionMembersInWorker(scope)).members.map((row) => row.identityId)).toEqual([
      profile.id,
    ]);
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
    expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
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
    expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
    await addSessionMember(scope, {
      identityId: profile.id,
      addedBy: "native-owner",
      addedAt: 123,
      expectedSessionId: entry.sessionId,
    });
    const explicitGrant = (await readSessionMembersInWorker(scope)).members;
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
    expect((await readSessionMembersInWorker(scope)).members).toEqual(explicitGrant);
  });
});

it.each(["scopes", "connection", "source", "profile", "abort", "replacement"] as const)(
  "rechecks %s authority after a queued lifecycle fence",
  async (revocation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
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
      const target = await prepareChannelSessionTarget({ cfg, key, agentId: "main" });
      const entered = createDeferred();
      const release = createDeferred();
      const fence = sessionLifecycle.runSessionMutation({
        diagnosticLabel: "sharing",
        target: sessionLifecycle.captureSessionTarget({
          storeScope: target.storePath,
          sessionKey: key,
          incarnation: "queued-session",
          agentId: "main",
        }),
        policy: "allow-live",
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      const queued = createDeferred();
      const runMutation = sessionLifecycle.runSessionMutation;
      const lifecycle = vi
        .spyOn(sessionLifecycle, "runSessionMutation")
        .mockImplementation((params) => {
          const pending = runMutation(params);
          queued.resolve();
          return pending;
        });
      const respond = vi.fn();
      const controller = new AbortController();
      let sourceCurrent = true;
      let profileCurrent = true;
      const pending = coreGatewayHandlers["sessions.channel.sync"]!({
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
        signal: controller.signal,
        hasCurrentClientAuthority: () => sourceCurrent,
        sessionMutationCommitGuard: () => {
          if (!profileCurrent) {
            throw new Error("selected profile changed");
          }
        },
      } as never);
      await queued.promise;
      lifecycle.mockRestore();
      let expectedError = "Gateway requester authority changed";
      if (revocation === "scopes") {
        client.connect.scopes = ["operator.write"];
        expectedError = "operator.admin required at channel synchronization commit";
      } else if (revocation === "connection") {
        client.invalidated = true;
      } else if (revocation === "abort") {
        controller.abort(new Error("request cancelled"));
        expectedError = "request cancelled";
      } else if (revocation === "profile") {
        profileCurrent = false;
        expectedError = "selected profile changed";
      } else if (revocation === "replacement") {
        await upsertSessionEntryCore(scope, {
          sessionId: "replacement",
          updatedAt: 2,
          createdVia: "channel",
        });
        expectedError = "channel session changed before synchronization";
      } else {
        sourceCurrent = false;
      }
      const rejected = expect(pending).rejects.toThrow(expectedError);
      release.resolve();
      await fence;
      await rejected;
      expect(respond).not.toHaveBeenCalled();
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
    });
  },
);

it.each(["provider", "chatType", "nativeChannelId"] as const)(
  "rejects contradictory %s provenance without changing members",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
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
      await coreGatewayHandlers["sessions.channel.sync"]!({
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
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
      expect(loadSessionEntry(scope)).toEqual(entry);
    });
  },
);

it.each([false, true])(
  "preserves an explicit owner grant after channel synchronization (same actor: %s)",
  async (sameActor) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      await captureRuntimeConfigAsyncReader()();
      const profile = ensureProfileForEmail("transferred-channel-reader@example.com");
      const owner = ensureProfileForEmail("channel-owner@example.com");
      const serviceClient = sameActor ? identifiedClient(owner.id) : soloClient();
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
        await coreGatewayHandlers["sessions.channel.sync"]!({
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
      const initial = (await readSessionMembersInWorker(scope)).members;
      expect(initial[0]?.addedBy).toBe(sameActor ? owner.id : "actor-evidence:unattributed");
      const grant = async () => {
        const responses = await callSessionSharingHandler(
          "session.members.add",
          { sessionKey: key, identityId: profile.id },
          context,
          identifiedClient(owner.id),
        );
        expect(responses[0]?.[0]).toBe(true);
      };
      await grant();
      const explicit = (await readSessionMembersInWorker(scope)).members;
      expect(explicit[0]?.addedBy).not.toBe(initial[0]?.addedBy);
      const listed = await callSessionSharingHandler(
        "session.members.listEvidence",
        { sessionKey: key },
        context,
        identifiedClient(owner.id),
      );
      expect(listed[0]?.[1]).toMatchObject({
        members: [{ identityId: profile.id, addedBy: owner.id }],
      });
      await grant();
      expect((await readSessionMembersInWorker(scope)).members).toEqual(explicit);
      await sync(true);
      expect((await readSessionMembersInWorker(scope)).members).toEqual(explicit);
      await sync(false);
      expect((await readSessionMembersInWorker(scope)).members).toEqual(explicit);
    });
  },
);
