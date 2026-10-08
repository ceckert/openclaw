import {
  ErrorCodes,
  errorShape,
  validateSessionMemberAddParams,
  validateSessionMemberRemoveParams,
  validateSessionMembersListParams,
  validateSessionVisibilitySetParams,
  validateSessionPublicShareSetParams,
  type SessionPublicShare,
  type SessionMember,
  type SessionMemberEvidence,
} from "../../../packages/gateway-protocol/src/index.js";
import { addSessionMember, removeSessionMember } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listProfiles } from "../../state/user-profiles.js";
import {
  loadPublicSessionShareTokenCodec,
  type PublicSessionShareTokenCodec,
} from "../control-ui-public-session-token.js";
import { projectSessionActor } from "../session-identity-projection.js";
import { prepareSessionPublicShareGrant } from "../session-publication-grant.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  allowedSessionVisibilities,
  isSessionVisibilityAllowed,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { measureSessionCollaborationPhase } from "./sessions-collaboration-diagnostics.js";
import { prepareManagedSessionAccess, sharingExpectedEntry } from "./sessions-sharing-authority.js";
import {
  actorIdentity,
  sharingActorStorageRef,
  projectSessionMemberEvidence,
  publishSharingChange,
} from "./sessions-sharing-events.js";
import { knownSessionIdentities } from "./sessions-sharing-identities.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

function runExclusiveSharingMutation<T>(
  target: SessionSharingTarget,
  storePath: string,
  run: () => Promise<T>,
): Promise<T> {
  // Sharing and lifecycle mutations share one exact-row fence so authorization
  // cannot change between archive's stop and commit boundaries.
  return runExclusiveSessionLifecycleMutation("sharing", {
    scope: storePath,
    identities: [target.canonicalKey, target.storeKey, ...target.storeKeys, target.entry.sessionId],
    run,
  });
}

function projectLegacySessionMember(member: SessionMemberEvidence): SessionMember | null {
  if (!member.addedBy) {
    return null;
  }
  return {
    identityId: member.identityId,
    addedBy: member.addedBy,
    addedAt: member.addedAt,
  };
}

function projectPublicSessionShare(params: {
  agentId: string;
  sessionKey: string;
  grant: NonNullable<ReturnType<typeof resolveSessionPublicShare>>;
  codec: PublicSessionShareTokenCodec;
}): SessionPublicShare {
  return {
    token: params.codec.mint({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.grant.sessionId,
      shareId: params.grant.id,
    }),
    createdAt: params.grant.createdAt,
  };
}

function createSessionMembersListHandler(
  method: "session.members.list" | "session.members.listEvidence",
): GatewayRequestHandlers[string] {
  const evidenceAware = method === "session.members.listEvidence";
  return async ({ params, respond, client, context, ...authority }) => {
    if (!assertValidParams(params, validateSessionMembersListParams, method, respond)) {
      return;
    }
    using access = await prepareManagedSessionAccess({
      ...authority,
      operation: "read",
      context,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!access) {
      return;
    }
    const managed = access.target;
    const projection = requireSessionRowProjection(context);
    await projection.withSelectionPreparation(async () => {
      const profiles = await measureSessionCollaborationPhase(`${method}.profiles`, () =>
        listProfiles(),
      );
      do {
        await measureSessionCollaborationPhase(`${method}.projection`, () =>
          Promise.resolve(projection.prepareSelection()),
        );
      } while (projection.needsSelectionPreparation());
      let tokenCodec = resolveSessionPublicShare(managed.entry)
        ? await loadPublicSessionShareTokenCodec()
        : undefined;
      const readEvidence = async () => {
        const evidence = await measureSessionCollaborationPhase(`${method}.evidence`, () =>
          readSessionMembersInWorker({
            agentId: managed.agentId,
            sessionKey: managed.storeKey,
            storePath: managed.storePath,
          }),
        );
        access.assertCurrent();
        if (!evidence.entry) {
          throw new Error("session changed before sharing read");
        }
        return { entry: evidence.entry, members: evidence.members };
      };
      let evidence = await readEvidence();
      if (resolveSessionPublicShare(evidence.entry) && !tokenCodec) {
        const prepared = loadPublicSessionShareTokenCodec();
        if (prepared instanceof Promise) {
          tokenCodec = await prepared;
          // Foreign publication can reveal a cold codec after discovery. Its wait
          // ends the read phase; authorize only the fresh row from the same target.
          evidence = await readEvidence();
        } else {
          tokenCodec = prepared;
        }
      }
      const { entry, members: storedMembers } = evidence;
      const publicShareGrant = resolveSessionPublicShare(entry);
      const currentCfg = context.getRuntimeConfig();
      const { target, role } = access.current(entry);
      const evidenceMembers = storedMembers.map(projectSessionMemberEvidence);
      const actor = actorIdentity(client);
      const members = evidenceAware
        ? evidenceMembers
        : evidenceMembers.map(projectLegacySessionMember);
      if (!evidenceAware && members.some((member) => member === null)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "session membership includes actor evidence this client cannot represent",
            {
              details: {
                code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
                recommendedMethod: "session.members.listEvidence",
              },
            },
          ),
        );
        return;
      }
      const projectedMembers = members.filter((member) => member !== null);
      const identities = knownSessionIdentities({
        creators: projection.listCreatedActors(),
        actor,
        profiles,
      });
      for (const member of projectedMembers) {
        if (!identities.some((identity) => identity.id === member.identityId)) {
          identities.push({ type: "human", id: member.identityId });
        }
      }
      identities.sort(
        (left, right) =>
          (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
          left.id.localeCompare(right.id),
      );
      // Persisted provenance deliberately has no current profile label or avatar.
      // Project it at the same display boundary as session rows; never change the access identity.
      const storedOwner = entry.createdActor;
      const owner = sessionCreatorProfileId(storedOwner)
        ? projectSessionActor(storedOwner, new Map(), currentCfg)
        : storedOwner
          ? { type: storedOwner.type, id: storedOwner.id, label: storedOwner.label }
          : undefined;
      const publicShare =
        publicShareGrant?.sessionId === target.entry.sessionId && tokenCodec
          ? projectPublicSessionShare({
              agentId: target.agentId,
              sessionKey: target.canonicalKey,
              grant: publicShareGrant,
              codec: tokenCodec,
            })
          : undefined;
      respond(
        true,
        {
          sessionKey: target.canonicalKey,
          ...(publicShare ? { publicShare } : {}),
          ...(owner?.id ? { owner } : {}),
          members: projectedMembers,
          identities,
          role,
          allowedVisibilities: allowedSessionVisibilities(currentCfg),
        },
        undefined,
      );
    });
  };
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.publicShare.set": defineValidatedGatewayHandler(
    "session.publicShare.set",
    validateSessionPublicShareSetParams,
    async ({ params, respond, client, context, ...authority }) => {
      using access = await prepareManagedSessionAccess({
        ...authority,
        context,
        client,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        respond,
      });
      if (!access) {
        return;
      }
      const managed = access.target;
      if (managed.entry.incognito || isIncognitoSessionKey(managed.canonicalKey)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Incognito sessions cannot be published."),
        );
        return;
      }
      if (managed.entry.sessionId !== params.expectedSessionId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Session changed; reopen sharing before publishing.",
          ),
        );
        return;
      }
      let publicShare: SessionPublicShare | undefined;
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const tokenCodec = params.enabled ? await loadPublicSessionShareTokenCodec() : undefined;
        const { target: current } = access.current();
        let changed = false;
        let inspected = false;
        await patchSessionEntryCore(
          {
            agentId: current.agentId,
            sessionKey: current.storeKey,
            storePath: current.storePath,
          },
          (entry) => {
            inspected = true;
            if (entry.sessionId !== params.expectedSessionId) {
              throw new Error("session changed before sharing mutation");
            }
            if (entry.incognito || isIncognitoSessionKey(current.canonicalKey)) {
              throw new Error("Incognito sessions cannot be published.");
            }
            access.assertEntryManageable(entry);
            const previous = resolveSessionPublicShare(entry);
            const publicShareGrant = params.enabled
              ? prepareSessionPublicShareGrant(entry, current.canonicalKey)
              : undefined;
            publicShare =
              publicShareGrant && tokenCodec
                ? projectPublicSessionShare({
                    agentId: current.agentId,
                    sessionKey: current.canonicalKey,
                    grant: publicShareGrant,
                    codec: tokenCodec,
                  })
                : undefined;
            changed = publicShareGrant?.id !== previous?.id;
            return changed ? { publicShare: publicShareGrant } : null;
          },
          {
            // Entry patches await preparation before committing. Recheck current
            // sharing authority on the synchronous commit edge, after that await.
            assertCommitAllowed: access.assertCurrent,
          },
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (changed) {
          emitSessionsChanged(context, {
            reason: "sharing",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
          });
        }
      });
      respond(
        true,
        {
          ok: true,
          sessionKey: managed.canonicalKey,
          ...(publicShare ? { publicShare } : {}),
        },
        undefined,
      );
    },
  ),
  "session.visibility.set": defineValidatedGatewayHandler(
    "session.visibility.set",
    validateSessionVisibilitySetParams,
    async ({ params, respond, client, context, ...authority }) => {
      using access = await prepareManagedSessionAccess({
        ...authority,
        context,
        client,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        respond,
      });
      if (!access) {
        return;
      }
      const managed = access.target;
      const visibility = params.visibility;
      if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `session visibility is disabled: ${visibility}`, {
            details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
          }),
        );
        return;
      }
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const { target: current } = access.current();
        const scope = {
          agentId: current.agentId,
          sessionKey: current.canonicalKey,
          storePath: current.storePath,
        };
        // The lifecycle fence excludes canonical reset/recreate. Keep the exact
        // session-id check at the storage boundary so an out-of-band row
        // replacement still cannot inherit this visibility change.
        let inspected = false;
        let changed = false;
        await patchSessionEntryCore(
          scope,
          (entry) => {
            inspected = true;
            access.assertEntryManageable(entry);
            if (resolveSessionVisibility(entry) === visibility) {
              return null;
            }
            changed = true;
            return { visibility };
          },
          {
            assertCommitAllowed: () => {
              access.assertCurrent();
              if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
                throw new Error(`session visibility is disabled: ${visibility}`);
              }
            },
          },
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (!changed) {
          return;
        }
        const now = Date.now();
        const actor = actorIdentity(client);
        publishSharingChange({
          context,
          actor,
          event: {
            action: "visibility",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
            visibility,
            ts: now,
          },
        });
      });
      respond(true, { ok: true, sessionKey: managed.canonicalKey, visibility }, undefined);
    },
  ),

  "session.members.list": createSessionMembersListHandler("session.members.list"),
  "session.members.listEvidence": createSessionMembersListHandler("session.members.listEvidence"),

  "session.members.add": async ({ params, respond, client, context, ...authority }) => {
    if (
      !assertValidParams(params, validateSessionMemberAddParams, "session.members.add", respond)
    ) {
      return;
    }
    using access = await prepareManagedSessionAccess({
      ...authority,
      context,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!access) {
      return;
    }
    const managed = access.target;
    const projection = requireSessionRowProjection(context);
    const profiles = await listProfiles();
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
    access.assertCurrent();
    const actor = actorIdentity(client);
    const known = knownSessionIdentities({
      creators: projection.listCreatedActors(),
      actor,
      profiles,
    });
    if (!known.some((identity) => identity.id === params.identityId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown identity"));
      return;
    }
    await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
      const { target: current } = access.current();
      const scope = {
        agentId: current.agentId,
        sessionKey: current.storeKey,
        storePath: current.storePath,
      };
      const now = Date.now();
      const added = await addSessionMember(
        scope,
        {
          identityId: params.identityId,
          addedBy: sharingActorStorageRef(actor),
          addedAt: now,
          expectedSessionId: current.entry.sessionId,
          expectedEntry: sharingExpectedEntry(current),
          replaceExisting: true,
        },
        access.assertCurrent,
      );
      if (!added.inserted && !added.updated) {
        return;
      }
      publishSharingChange({
        context,
        actor,
        event: {
          action: "member-added",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          identityId: params.identityId,
          ts: now,
        },
      });
    });
    respond(
      true,
      { ok: true, sessionKey: managed.canonicalKey, identityId: params.identityId },
      undefined,
    );
  },

  "session.members.remove": defineValidatedGatewayHandler(
    "session.members.remove",
    validateSessionMemberRemoveParams,
    async ({ params, respond, client, context, ...authority }) => {
      using access = await prepareManagedSessionAccess({
        ...authority,
        context,
        client,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        respond,
      });
      if (!access) {
        return;
      }
      const managed = access.target;
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const { target: current } = access.current();
        const scope = {
          agentId: current.agentId,
          sessionKey: current.storeKey,
          storePath: current.storePath,
        };
        const removed = await removeSessionMember(
          scope,
          params.identityId,
          undefined,
          current.entry.sessionId,
          access.assertCurrent,
          sharingExpectedEntry(current),
        );
        if (!removed) {
          return;
        }
        const now = Date.now();
        const actor = actorIdentity(client);
        publishSharingChange({
          context,
          actor,
          event: {
            action: "member-removed",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
            identityId: params.identityId,
            ts: now,
          },
        });
      });
      respond(
        true,
        { ok: true, sessionKey: managed.canonicalKey, identityId: params.identityId },
        undefined,
      );
    },
  ),
};
