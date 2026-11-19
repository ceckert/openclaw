import type { MattermostMonitorContext } from "./monitor-types.js";

const AUTHORIZE = "octogee.activity.authorizeChannelRunInput";

export async function resolveOctogeeRunInput(params: {
  request: unknown;
  gateway: MattermostMonitorContext["core"]["gateway"];
  sessionKey: string;
  senderId: string;
  signal?: AbortSignal;
}) {
  const { request, gateway, sessionKey, senderId, signal } = params;
  if (request === undefined) return undefined;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const { runId, mode } = request as Record<string, unknown>;
  if (
    typeof runId !== "string" ||
    !runId ||
    runId.length > 256 ||
    (mode !== "queue" && mode !== "steer")
  ) {
    return null;
  }
  const access = await gateway.request<{ allowed?: boolean; allowCollaborativeSteering?: boolean }>(
    AUTHORIZE,
    { sessionKey, senderId, runId, mode },
    { scopes: ["operator.admin"], timeoutMs: 5_000, signal },
  );
  if (access.allowed !== true) return null;
  return mode === "queue"
    ? { mode: "followup" as const, runId }
    : {
        mode: "steer" as const,
        runId,
        allowCollaborativeSteering: access.allowCollaborativeSteering === true,
      };
}
