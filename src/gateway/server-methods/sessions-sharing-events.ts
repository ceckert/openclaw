import type {
  SessionMemberEvidence,
  SessionSharingEvent,
  SessionSharingEvidenceEvent,
  SessionSharingIdentity,
} from "../../../packages/gateway-protocol/src/index.js";
import type { listSessionMembers } from "../../config/sessions.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const UNKNOWN_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unknown";
const UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unattributed";
const LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS = new Set(["local-operator", "operator.admin"]);

export type SharingActorFacts =
  | { state: "present"; actor: SessionSharingIdentity }
  | { state: "unknown" }
  | { state: "absent" };

export function actorIdentity(client: GatewayClient | null): SharingActorFacts {
  const principal = gatewayClientSessionCreator(client);
  if (principal) {
    return { state: "present", actor: principal };
  }
  return getGatewayLocalUserIngress(client)?.facts.invoker?.state === "unknown"
    ? { state: "unknown" }
    : { state: "absent" };
}

export function sharingActorStorageRef(facts: SharingActorFacts): string {
  return facts.state === "present"
    ? facts.actor.id
    : facts.state === "unknown"
      ? UNKNOWN_SHARING_ACTOR_STORAGE_REF
      : UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF;
}

export function projectSessionMemberEvidence(
  member: ReturnType<typeof listSessionMembers>[number],
): SessionMemberEvidence {
  // Sentinel ids satisfy the existing non-null storage contract only. Project
  // actor evidence here so persistence markers never become protocol identities.
  const common = { identityId: member.identityId, addedAt: member.addedAt };
  if (member.addedBy === UNKNOWN_SHARING_ACTOR_STORAGE_REF) {
    return { ...common, addedByState: "unknown" };
  }
  if (
    member.addedBy === UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF ||
    LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS.has(member.addedBy)
  ) {
    // Beta builds stored fabricated operator ids before actor evidence became
    // tri-state. Discard those unshipped values instead of presenting principals.
    return common;
  }
  return { ...common, addedBy: member.addedBy };
}

export function publishSharingChange(params: {
  context: GatewayRequestContext;
  actor: SharingActorFacts;
  event: Omit<SessionSharingEvidenceEvent, "actorState">;
  agentId: string;
}): void {
  bumpGatewayAccessRevision();
  invalidateSessionSharingSnapshot(params.event.sessionKey);
  const eventOptions = {
    sessionKeys: [params.event.sessionKey],
  };
  if (params.actor.state === "present") {
    const event: SessionSharingEvent = { ...params.event, actor: params.actor.actor };
    params.context.broadcast("session.sharing", event, eventOptions);
  } else {
    const event: SessionSharingEvidenceEvent = {
      ...params.event,
      ...(params.actor.state === "unknown" ? { actorState: "unknown" } : {}),
    };
    params.context.broadcast("session.sharing.evidence", event, eventOptions);
  }
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}
