import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { AuthorizedControlUiReadRequest } from "./http-auth-utils.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";

export async function prepareWorkspaceIconRead(params: {
  sessionKey: string;
  agentId: string;
  auth: AuthorizedControlUiReadRequest;
  getRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
}) {
  let profile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let session: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  const release = () => {
    session?.release();
    profile?.release();
  };
  try {
    const profileId = params.auth.authenticatedUserProfile?.profileId;
    if (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID) {
      profile = await prepareUserProfileIdentity(profileId);
      params.assertCurrent();
    }
    session = await prepareSessionMutationFacts({
      cfg: params.getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    params.assertCurrent();
    const retainedSession = session;
    return {
      release,
      canRead() {
        params.assertCurrent();
        const cfg = params.getRuntimeConfig();
        const identity = profile?.readCurrentFacts();
        const facts = retainedSession.readCurrent(cfg);
        const sharing = prepareProjectedSessionSharing({
          cfg,
          client: {
            connect: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: "gateway-client",
                version: "internal",
                platform: "node",
                mode: "backend",
              },
              role: "operator",
              scopes: params.auth.operatorScopes,
            },
            authenticatedUserProfile: params.auth.authenticatedUserProfile,
            ...(identity
              ? {
                  preparedSessionProfile: {
                    profileId: identity.profile.profileId,
                    role: identity.profile.assignedRole,
                    aliases: identity.aliases,
                  },
                }
              : {}),
          },
          resolveTarget: () => facts.target,
          isMember: (_target, identityId) => facts.membership.has(identityId),
        });
        return sharing.entryFilter?.(facts.target.canonicalKey, facts.target.entry) !== false;
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
