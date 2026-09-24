import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { CronMigrationRequest } from "../../cron/migration.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readCronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandler } from "./types.js";

function parseRequest(value: unknown): CronMigrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid cron migration request");
  }
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some((key) => !["operationId", "phase", "agentIds", "snapshot"].includes(key)) ||
    typeof p.operationId !== "string" ||
    typeof p.phase !== "string" ||
    !["hold", "export", "stage", "activate", "resume", "retire", "abort"].includes(p.phase) ||
    (p.agentIds !== undefined &&
      (!Array.isArray(p.agentIds) || p.agentIds.some((id) => typeof id !== "string"))) ||
    ((p.phase === "hold" || p.phase === "stage") && p.agentIds === undefined) ||
    (p.snapshot !== undefined && p.phase !== "stage")
  ) {
    throw new Error("Invalid cron migration request");
  }
  return p as CronMigrationRequest;
}

export const handleCronMigration: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  hasCurrentClientAuthority,
  sessionMutationCommitGuard,
}) => {
  try {
    if (readCronCallerScope(client)) {
      throw new Error("Cron migration requires an unscoped operator");
    }
    const request = parseRequest(params);
    const assertCurrent = () => {
      if (hasCurrentClientAuthority?.() === false) {
        throw new Error("Cron migration caller authority expired");
      }
      sessionMutationCommitGuard?.();
    };
    assertCurrent();
    const result = await context.cron.migration(request, assertCurrent);
    respond(true, result, undefined);
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
  }
};
