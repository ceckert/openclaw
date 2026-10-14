import { buildToolRequesterContext } from "../agent-tools.requester.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

/** Requester facts a harness host forwards to tool hooks, frozen from the admitted attempt. */
export function buildHarnessHostRequester(
  attempt: Pick<
    Partial<EmbeddedRunAttemptParams>,
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "senderId"
    | "senderIsOwner"
    | "memberRoleIds"
  >,
) {
  const requester = buildToolRequesterContext(attempt);
  if (requester.roleIds) {
    Object.freeze(requester.roleIds);
  }
  return requester;
}
