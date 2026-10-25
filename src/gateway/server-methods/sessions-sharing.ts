import {
  ErrorCodes,
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
import {
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
} from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
} from "../../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { listResidentUserProfileDisplayFacts } from "../../state/user-profile-list.js";
import {
  encodePublicSessionShareLocator,
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
import { respondError } from "./response.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { measureSessionCollaborationPhase } from "./sessions-collaboration-diagnostics.js";
import { prepareManagedSessionAccess, sharingExpectedEntry } from "./sessions-sharing-authority.js";
import {
  actorIdentity,
  sharingActorStorageRef,
  projectSessionMemberEvidence,
  publishSharingChange,
} from "./sessions-sharing-events.js";
import { knownSessionIdentities, type SharingActorFacts } from "./sessions-sharing-identities.js";
import { projectSessionMemberPermissions } from "./sessions-sharing-permissions.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

function runExclusiveSharingMutation<T>(
  target: SessionSharingTarget,
  lifecycleStorePath: string,
  run: () => Promise<T>,
): Promise<T> {
  // Sharing and lifecycle mutations share one exact-row fence so authorization
  // cannot change between archive's stop and commit boundaries.
  return runSessionMutation({
    diagnosticLabel: "sharing",
    target: captureSessionTarget({
      storeScope: lifecycleStorePath,
      sessionKey: target.canonicalKey,
      aliases: [target.storeKey, ...target.storeKeys],
      incarnation: target.entry.sessionId,
      agentId: target.agentId,
    }),
    policy: "allow-live",
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

function defineManagedSessionHandler<T extends { sessionKey: string; agentId?: string }>(
  method: string,
  validate: Validator<T>,
  handler: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: T },
    access: NonNullable<Awaited<ReturnType<typeof prepareManagedSessionAccess>>>,
  ) => Promise<void>,
  operation: "read" | "mutation" = "mutation",
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(method, validate, async (options) => {
    using access = await prepareManagedSessionAccess({
      ...options,
      sessionKey: options.params.sessionKey,
      agentId: options.params.agentId,
      operation,
    });
    if (access) {
      await handler(options, access);
    }
  });
}

function createSessionMembersListHandler(
  method: "session.members.list" | "session.members.listEvidence",
): GatewayRequestHandlers[string] {
  const evidenceAware = method === "session.members.listEvidence";
  return defineManagedSessionHandler(
    method,
    validateSessionMembersListParams,
    async ({ respond, client, context }, access) => {
      const managed = access.target;
      const projection = requireSessionRowProjection(context);
      await projection.withSelectionPreparation(async () => {
        do {
          await measureSessionCollaborationPhase(`${method}.projection`, () =>
            Promise.resolve(projection.prepareSelection({ metadataOnly: true })),
          );
        } while (projection.needsSelectionPreparation({ metadataOnly: true }));
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
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            "session membership includes actor evidence this client cannot represent",
            {
              details: {
                code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
                recommendedMethod: "session.members.listEvidence",
              },
            },
          );
          return;
        }
        const projectedMembers = members.filter((member) => member !== null);
        const profiles = listResidentUserProfileDisplayFacts();
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
        const storedOwner = resolveSessionCreatorActor(entry.createdActor);
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
            ...(evidenceAware
              ? {
                  permissions: projectSessionMemberPermissions({
                    cfg: context.getCommittedRuntimeConfig?.() ?? currentCfg,
                    client,
                    target: { ...target, entry },
                    members: evidenceMembers,
                    identities,
                    profiles,
                  }),
                }
              : {}),
            role,
            allowedVisibilities: allowedSessionVisibilities(currentCfg),
          },
          undefined,
        );
      });
    },
    "read",
  );
}

function createSessionMemberMutationHandler(
  action: "add" | "remove",
): GatewayRequestHandlers[string] {
  return defineManagedSessionHandler(
    `session.members.${action}`,
    action === "add" ? validateSessionMemberAddParams : validateSessionMemberRemoveParams,
    async ({ params, respond, client, context }, access) => {
      const managed = access.target;
      let addActor: SharingActorFacts | undefined;
      if (action === "add") {
        const projection = requireSessionRowProjection(context);
        do {
          await projection.prepareSelection({ metadataOnly: true });
        } while (projection.needsSelectionPreparation({ metadataOnly: true }));
        access.assertCurrent();
        addActor = actorIdentity(client);
        const known = knownSessionIdentities({
          creators: projection.listCreatedActors(),
          actor: addActor,
          profiles: listResidentUserProfileDisplayFacts(),
        });
        if (!known.some((identity) => identity.id === params.identityId)) {
          respondError(respond, ErrorCodes.INVALID_REQUEST, "unknown identity");
          return;
        }
      }
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        const { target: current } = access.current();
        const scope = {
          agentId: current.agentId,
          sessionKey: current.storeKey,
          storePath: current.storePath,
        };
        let now: number;
        let actor: SharingActorFacts;
        if (addActor) {
          now = Date.now();
          actor = addActor;
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
        } else {
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
          now = Date.now();
          actor = actorIdentity(client);
        }
        publishSharingChange({
          context,
          actor,
          event: {
            action: action === "add" ? "member-added" : "member-removed",
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
  );
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.publicShare.set": defineManagedSessionHandler(
    "session.publicShare.set",
    validateSessionPublicShareSetParams,
    async ({ params, respond, context }, access) => {
      const managed = access.target;
      if (managed.entry.incognito || isIncognitoSessionKey(managed.canonicalKey)) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          "Incognito sessions cannot be published.",
        );
        return;
      }
      if (managed.entry.sessionId !== params.expectedSessionId) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          "Session changed; reopen sharing before publishing.",
        );
        return;
      }
      let publicShareGrant: ReturnType<typeof resolveSessionPublicShare>;
      let tokenCodec: PublicSessionShareTokenCodec | undefined;
      await runExclusiveSharingMutation(managed, access.lifecycleStorePath, async () => {
        tokenCodec = params.enabled ? await loadPublicSessionShareTokenCodec() : undefined;
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
            publicShareGrant = params.enabled
              ? prepareSessionPublicShareGrant(entry, current.canonicalKey)
              : undefined;
            if (publicShareGrant) {
              encodePublicSessionShareLocator({
                agentId: current.agentId,
                sessionKey: current.canonicalKey,
                sessionId: publicShareGrant.sessionId,
                shareId: publicShareGrant.id,
              });
            }
            changed = publicShareGrant?.id !== previous?.id;
            return changed ? { publicShare: publicShareGrant } : null;
          },
          {
            // Entry patches await preparation before committing. Recheck current
            // sharing authority on the synchronous commit edge, after that await.
            ...sessionEntryCommitGuardOptions(access.assertCurrent),
          },
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (changed) {
          access.current();
          emitSessionsChanged(context, {
            reason: "sharing",
            sessionKey: current.canonicalKey,
            agentId: current.agentId,
          });
        }
      });
      const { target: published } = access.current();
      const currentGrant = resolveSessionPublicShare(published.entry);
      if (currentGrant?.id !== publicShareGrant?.id) {
        throw new Error("session publication changed before sharing response");
      }
      const publicShare =
        currentGrant && tokenCodec
          ? projectPublicSessionShare({
              agentId: published.agentId,
              sessionKey: published.canonicalKey,
              grant: currentGrant,
              codec: tokenCodec,
            })
          : undefined;
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
  "session.visibility.set": defineManagedSessionHandler(
    "session.visibility.set",
    validateSessionVisibilitySetParams,
    async ({ params, respond, client, context }, access) => {
      const managed = access.target;
      const visibility = params.visibility;
      const assertVisibilityCurrent = () => {
        const { target } = access.current();
        if (resolveSessionVisibility(target.entry) !== visibility) {
          throw new Error("session visibility changed before sharing response");
        }
      };
      if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `session visibility is disabled: ${visibility}`,
          {
            details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
          },
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
        const commitGuard = composeSessionSourceAssertion(
          [access.assertCurrent],
          (assertSources) => {
            assertSources();
            if (!isSessionVisibilityAllowed(context.getRuntimeConfig(), visibility)) {
              throw new Error(`session visibility is disabled: ${visibility}`);
            }
          },
        );
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
          sessionEntryCommitGuardOptions(commitGuard),
        );
        if (!inspected) {
          throw new Error("session changed before sharing mutation");
        }
        if (!changed) {
          return;
        }
        const now = Date.now();
        const actor = actorIdentity(client);
        assertVisibilityCurrent();
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
      assertVisibilityCurrent();
      respond(true, { ok: true, sessionKey: managed.canonicalKey, visibility }, undefined);
    },
  ),

  "session.members.list": createSessionMembersListHandler("session.members.list"),
  "session.members.listEvidence": createSessionMembersListHandler("session.members.listEvidence"),

  "session.members.add": createSessionMemberMutationHandler("add"),
  "session.members.remove": createSessionMemberMutationHandler("remove"),
};
