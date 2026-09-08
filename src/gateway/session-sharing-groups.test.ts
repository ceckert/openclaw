import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  listSessionGroupDefaults,
  listSessionGroups,
  putSessionGroups,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  invalidateSessionSharingSnapshot,
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import {
  sharingPolicyClient as client,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

describe("session sharing group mutations", () => {
  afterEach(() => {
    flushPendingSessionsChangedEvents();
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(["rename", "delete"])(
    "refreshes groups after %s rejects changed member authority",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        putSessionGroups({ cfg: {}, names: ["Old"] });
        const sessionKey = "agent:main:changed-group-authority";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "changed-group-authority",
            updatedAt: 1,
            category: "Old",
          },
        );
        const error = new SessionMutationAuthorizationChangedError({
          code: "INVALID_REQUEST",
          message: "member authority changed",
          details: { reason: "changed" },
        });
        const broadcastToConnIds = vi.fn();
        const respond = vi.fn();
        const context = {
          getRuntimeConfig: () => ({}),
          getSessionEventSubscriberConnIds: () => new Set(["group-observer"]),
          broadcastToConnIds,
        } as unknown as GatewayRequestContext;
        await expect(
          sessionGroupHandlers[`sessions.groups.${action}`]?.({
            params: { name: "Old", ...(action === "rename" ? { to: "New" } : {}) },
            context,
            respond,
            sessionMutationAuthorization: {
              assertCurrent: () => {},
              assertTargetCurrent: () => {
                throw error;
              },
            },
          } as never),
        ).rejects.toMatchObject({
          name: "SessionMutationAuthorizationChangedError",
          error: {
            code: "INVALID_REQUEST",
            details: { reason: "changed" },
            message: expect.stringContaining("retry"),
          },
        });
        expect(respond).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.category).toBe("Old");
        expect(listSessionGroups()).toContainEqual({ name: "Old", position: 0 });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "groups" }),
          new Set(["group-observer"]),
          expect.any(Object),
        );
      });
    },
  );
  it("refuses restricted group drops at put admission while allowing retained groups", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Projects"] });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-put-member" },
        {
          sessionId: "session-restricted-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = roleClient("none", "put-viewer");
      const context = { getRuntimeConfig: () => rolePolicyConfig() } as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [] },
          context,
        }).error,
      ).not.toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [" Projects "] },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("rechecks late group members before committing a put drop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const groups = putSessionGroups({ cfg: {}, names: ["Race"] });
      const viewer = roleClient("none", "put-viewer");
      const context = {
        getRuntimeConfig: () => rolePolicyConfig(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.put",
        requestParams: { names: [] },
        context,
      });
      expect(authorization).toMatchObject({ error: null, authorization: expect.any(Object) });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-put-member" },
        {
          sessionId: "session-late-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.put"]?.({
          params: { names: [] },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroups()).toEqual(groups);
    });
  });

  it("rechecks group members before committing a defaults update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Race"] });
      updateSessionGroupDefaults("Race", { cwd: "/repos/race", worktree: true });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: " Race ", cwd: null, worktree: false },
        context,
      });
      expect(authorization.error).toBeNull();

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-restricted-member" },
        {
          sessionId: "session-late-restricted-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.update"]?.({
          params: { name: " Race ", cwd: null, worktree: false },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroupDefaults()).toEqual([
        { name: "Race", cwd: "/repos/race", worktree: true },
      ]);
    });
  });

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Projects", "Personal"] });
      updateSessionGroupDefaults("Projects", { cwd: "/repos/projects", worktree: true });
      updateSessionGroupDefaults("Personal", { cwd: "/repos/personal", worktree: false });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-project" },
        {
          sessionId: "session-restricted-project",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { name: "Projects", cwd: null, worktree: false },
          context,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.defaults"]?.({
        params: {},
        client: viewer,
        context,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      expect(responses).toEqual([
        [
          true,
          { defaults: [{ name: "Personal", cwd: "/repos/personal", worktree: false }] },
          undefined,
        ],
      ]);

      const personalAuthorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: "Personal", cwd: null, worktree: false },
        context,
      });
      expect(personalAuthorization.error).toBeNull();
      const updateResponses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.update"]?.({
        params: { name: "Personal", cwd: null, worktree: false },
        client: viewer,
        context,
        sessionMutationAuthorization: personalAuthorization.authorization,
        respond: (...response: Parameters<RespondFn>) => updateResponses.push(response),
      } as never);
      expect(updateResponses).toEqual([
        [true, { ok: true, defaults: [{ name: "Personal", worktree: false }] }, undefined],
      ]);
    });
  });
});

describe("synchronized native channel membership", () => {
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
      const event = () =>
        canReceiveSessionEvent({ cfg, client: member, sessionKeys: [sessionKey] });
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
        expect(
          createSessionListEntryFilter({ cfg, client: member })!(sessionKey, target.entry),
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
});
