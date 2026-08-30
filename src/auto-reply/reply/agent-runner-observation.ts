import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

export function resolveAgentRunObservation(params: AgentTurnParams) {
  if (params.followupRun.strandedReplyRetry === true) {
    return {
      origin: "retry" as const,
      ...(params.followupRun.retryOfRunId ? { retryOfRunId: params.followupRun.retryOfRunId } : {}),
    };
  }
  if (params.isHeartbeat) {
    return { origin: "scheduled" as const };
  }
  if (isSubagentSessionKey(params.sessionKey ?? params.followupRun.run.sessionKey)) {
    return { origin: "subagent" as const };
  }
  return params.followupRun.run.inputProvenance?.kind === "external_user" ||
    params.followupRun.run.inputProvenance === undefined
    ? { origin: "human" as const }
    : { origin: "followup" as const };
}
