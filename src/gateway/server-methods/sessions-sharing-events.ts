import type { SessionMemberEvidence } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionMember as StoredSessionMember } from "../../config/sessions/session-membership-facts.types.js";
import { decodeSessionMemberActor } from "../../config/sessions/session-sharing-store.kernel.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import type { SharingActorFacts } from "./sessions-sharing-identities.js";
import type { GatewayClient } from "./types.js";

const UNKNOWN_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unknown";
const UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unattributed";
const LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS = new Set(["local-operator", "operator.admin"]);

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

export function projectSessionMemberEvidence(member: StoredSessionMember): SessionMemberEvidence {
  // Sentinel ids satisfy the existing non-null storage contract only. Project
  // actor evidence here so persistence markers never become protocol identities.
  const common = {
    identityId: member.identityId,
    addedAt: member.addedAt,
    ...(member.access !== undefined ? { access: member.access } : {}),
  };
  const addedBy = decodeSessionMemberActor(member.addedBy);
  if (addedBy === UNKNOWN_SHARING_ACTOR_STORAGE_REF) {
    return { ...common, addedByState: "unknown" };
  }
  if (
    addedBy === UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF ||
    LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS.has(addedBy)
  ) {
    // Beta builds stored fabricated operator ids before actor evidence became
    // tri-state. Discard those unshipped values instead of presenting principals.
    return common;
  }
  return { ...common, addedBy };
}
