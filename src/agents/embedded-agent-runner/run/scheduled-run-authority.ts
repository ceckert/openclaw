import type { RunEmbeddedAgentParams } from "./params.js";

/** Projects a scheduled run's host-owned authority facts onto its attempt. */
export function projectScheduledRunAuthority(
  params: Pick<
    RunEmbeddedAgentParams,
    | "scheduledToolPolicy"
    | "scheduledRequester"
    | "cronCreatorAuthorityCapability"
    | "cronCreatorAuthorityUnavailableReason"
  >,
) {
  return {
    scheduledToolPolicy: params.scheduledToolPolicy,
    scheduledRequester: params.scheduledRequester,
    cronCreatorAuthorityCapability: params.cronCreatorAuthorityCapability,
    cronCreatorAuthorityUnavailableReason: params.cronCreatorAuthorityUnavailableReason,
  };
}
