import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionChannelSyncParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { addSessionMember, removeSessionMember } from "../../config/sessions.js";
import { ensureSessionEntryInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { listSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listProfiles } from "../../state/user-profiles.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { prepareChannelSessionTarget } from "./sessions-channel-target.js";
import {
  actorIdentity,
  sharingActorStorageRef,
  publishSharingChange,
} from "./sessions-sharing-events.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionChannelSyncHandler: GatewayRequestHandlers[string] = async (options) => {
  const { params, respond, client, context, signal } = options;
  if (
    !assertValidParams(params, validateSessionChannelSyncParams, "sessions.channel.sync", respond)
  ) {
    return;
  }
  if (!isGatewayAdmin(client)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "operator.admin required"));
    return;
  }
  const authority = readGatewayRequestMutationAuthority(options);
  authority.assertCurrent();
  const cfg = context.getRuntimeConfig();
  const key = buildAgentPeerSessionKey({ ...params, groupScope: cfg.session?.groupScope });
  if (key !== `agent:${params.agentId}:${params.channel}:${params.peerKind}:${params.peerId}`) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "channel identity must be canonical"),
    );
    return;
  }
  const requestedAgent = resolveRequestedSessionAgentId(cfg, key, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  if (params.member && !(await listProfiles()).some((profile) => profile.id === params.profileId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown profile"));
    return;
  }
  const initial = await prepareChannelSessionTarget({
    cfg,
    key,
    agentId: params.agentId,
  });
  authority.assertCurrent();
  await runExclusiveSessionLifecycleMutation({
    signal,
    scope: initial.storePath,
    identities: [
      key,
      ...initial.storeKeys,
      ...(initial.store[key] ? [initial.store[key].sessionId] : []),
    ],
    run: async () => {
      const profiles = params.member ? await listProfiles() : [];
      authority.assertCurrent();
      if (!isGatewayAdmin(client)) {
        throw new Error("operator.admin required at channel synchronization commit");
      }
      const assertCurrent = () => {
        authority.assertCurrent();
        if (!isGatewayAdmin(client)) {
          throw new Error("operator.admin required at channel synchronization commit");
        }
        const commitCfg = context.getRuntimeConfig();
        const selected = resolveRequestedSessionAgentId(commitCfg, key, params.agentId);
        if (
          !selected.ok ||
          buildAgentPeerSessionKey({ ...params, groupScope: commitCfg.session?.groupScope }) !==
            key ||
          commitCfg.session?.store !== currentCfg.session?.store
        ) {
          throw new Error("channel agent changed before synchronization");
        }
      };
      const currentCfg = context.getRuntimeConfig();
      const agent = resolveRequestedSessionAgentId(currentCfg, key, params.agentId);
      if (
        !agent.ok ||
        buildAgentPeerSessionKey({ ...params, groupScope: currentCfg.session?.groupScope }) !== key
      ) {
        throw new Error("channel agent changed before synchronization");
      }
      const resolved = await prepareChannelSessionTarget({
        cfg: currentCfg,
        key,
        agentId: params.agentId,
      });
      assertCurrent();
      if (resolved.storePath !== initial.storePath || resolved.canonicalKey !== key) {
        throw new Error("channel store changed before synchronization");
      }
      const scope = { agentId: params.agentId, sessionKey: key, storePath: resolved.storePath };
      let entry: (typeof resolved.store)[string] | undefined = resolved.store[key];
      if (initial.store[key] && entry?.sessionId !== initial.store[key].sessionId) {
        throw new Error("channel session changed before synchronization");
      }
      if (!entry && !params.member) {
        respond(true, { key, changed: false }, undefined);
        return;
      }
      if (params.member && !profiles.some((profile) => profile.id === params.profileId)) {
        throw new Error("profile removed before channel synchronization");
      }
      if (!entry) {
        const initialEntry = {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          createdVia: "channel" as const,
          ...(params.displayName ? { displayName: params.displayName } : {}),
          chatType: params.peerKind,
        };
        await ensureSessionEntryInWorker(scope, initialEntry, assertCurrent);
        assertCurrent();
        const created = await prepareChannelSessionTarget({
          cfg: currentCfg,
          key,
          agentId: params.agentId,
        });
        assertCurrent();
        if (created.storePath !== resolved.storePath) {
          throw new Error("channel store changed before synchronization");
        }
        entry = created.store[key];
      }
      const origin = sessionDeliveryOrigin(entry);
      if (
        !entry ||
        entry.createdVia !== "channel" ||
        (params.member && (entry.incognito || entry.visibility === "draft")) ||
        (origin?.provider && origin.provider !== params.channel) ||
        (origin?.chatType && origin.chatType !== params.peerKind) ||
        (origin?.nativeChannelId && origin.nativeChannelId !== params.peerId)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "session does not match channel provenance"),
        );
        return;
      }
      const actor = actorIdentity(client);
      const now = Date.now();
      const currentMember = params.member
        ? undefined
        : (await listSessionMembersInWorker(scope)).find(
            (member) => member.identityId === params.profileId,
          );
      assertCurrent();
      const synchronizedMember =
        currentMember?.addedBy === sharingActorStorageRef(actor) ? currentMember : undefined;
      const changed = params.member
        ? (
            await addSessionMember(
              scope,
              {
                identityId: params.profileId,
                addedBy: sharingActorStorageRef(actor),
                addedAt: now,
                expectedSessionId: entry.sessionId,
                expectedEntry: {
                  sessionId: entry.sessionId,
                  createdActor: entry.createdActor,
                  createdVia: entry.createdVia,
                  visibility: entry.visibility,
                  incognito: entry.incognito,
                },
              },
              assertCurrent,
            )
          ).inserted
        : Boolean(
            synchronizedMember &&
            (await removeSessionMember(
              scope,
              params.profileId,
              synchronizedMember,
              entry.sessionId,
              assertCurrent,
              {
                sessionId: entry.sessionId,
                createdActor: entry.createdActor,
                createdVia: entry.createdVia,
                visibility: entry.visibility,
                incognito: entry.incognito,
              },
            )),
          );
      if (changed) {
        publishSharingChange({
          context,
          actor,
          agentId: params.agentId,
          event: {
            action: params.member ? "member-added" : "member-removed",
            sessionKey: key,
            agentId: params.agentId,
            identityId: params.profileId,
            ts: now,
          },
        });
      }
      respond(true, { key, sessionId: entry.sessionId, changed }, undefined);
    },
  });
};
