import { randomUUID } from "node:crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureScheduledOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import {
  CRON_MIGRATION_OPERATION_ID_PATTERN,
  parseCronMigrationSnapshot,
} from "../../cron/migration-snapshot.js";
import type { CronMigrationRequest } from "../../cron/migration.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { narrowOperatorSourceToGrant } from "../cron-operator-source.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { decodeGatewayOperatorRecoverySource } from "../operator-run-recovery-source.codec.js";
import { readCronCallerScope } from "./cron-caller-scope.js";
import type { GatewayRequestHandler } from "./types.js";

const REQUEST_KEYS = new Set([
  "operationId",
  "phase",
  "agentIds",
  "snapshot",
  "retainNonportable",
  "targetRequesterProfileId",
]);

function parseRequest(
  value: unknown,
): CronMigrationRequest | { operationId: string; phase: "stage-requester" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid cron migration request");
  }
  // SAFETY: the guard above established a non-null, non-array object.
  const p = value as Record<string, unknown>;
  if (p.phase === "stage-requester") {
    if (
      typeof p.operationId !== "string" ||
      !CRON_MIGRATION_OPERATION_ID_PATTERN.test(p.operationId) ||
      Object.keys(p).some((key) => key !== "operationId" && key !== "phase")
    ) {
      throw new Error("Invalid cron migration request");
    }
    return { operationId: p.operationId, phase: p.phase };
  }
  if (
    Object.keys(p).some((key) => !REQUEST_KEYS.has(key)) ||
    typeof p.operationId !== "string" ||
    typeof p.phase !== "string" ||
    !["hold", "export", "stage", "activate", "resume", "retire", "abort"].includes(p.phase) ||
    (p.agentIds !== undefined &&
      (!Array.isArray(p.agentIds) || p.agentIds.some((id) => typeof id !== "string"))) ||
    ((p.phase === "hold" || p.phase === "stage") && p.agentIds === undefined) ||
    (p.snapshot !== undefined && p.phase !== "stage") ||
    (p.retainNonportable !== undefined &&
      (typeof p.retainNonportable !== "boolean" ||
        !["hold", "export", "stage"].includes(p.phase))) ||
    (p.targetRequesterProfileId !== undefined &&
      (p.phase !== "export" ||
        p.retainNonportable !== true ||
        (p.targetRequesterProfileId !== null &&
          (typeof p.targetRequesterProfileId !== "string" ||
            !p.targetRequesterProfileId.trim() ||
            p.targetRequesterProfileId.length > 512))))
  ) {
    throw new Error("Invalid cron migration request");
  }
  const snapshot = p.snapshot === undefined ? undefined : parseCronMigrationSnapshot(p.snapshot);
  // SAFETY: every key, the phase literal, agentIds, the flag, and the snapshot were validated above.
  return { ...(p as Omit<CronMigrationRequest, "snapshot">), ...(snapshot ? { snapshot } : {}) };
}

/**
 * A gateway-kind source names the exporting Gateway's paired device, which the staging
 * Gateway never paired. The same requester re-grants it here, as `cron.add` does on
 * create, narrowed to what the stored grant allowed.
 */
async function rebindStagedGatewaySources(
  request: CronMigrationRequest,
  caller: Pick<
    Parameters<GatewayRequestHandler>[0],
    "client" | "context" | "hasCurrentClientAuthority"
  >,
): Promise<{ request: CronMigrationRequest; assertCurrent: () => void; release: () => void }> {
  const sourced =
    request.phase === "stage"
      ? (request.snapshot?.jobs ?? []).flatMap((job) => {
          if (!job.operatorSource) {
            return [];
          }
          const original = decodeGatewayOperatorRecoverySource(job.operatorSource.source);
          return original.kind === "gateway" ? [{ job, original }] : [];
        })
      : [];
  if (sourced.length === 0) {
    return { request, assertCurrent: () => {}, release: () => {} };
  }
  const captured = await captureGatewayOperatorRunAuthority({
    client: caller.client,
    context: caller.context,
    hasCurrentClientAuthority: caller.hasCurrentClientAuthority,
  });
  if (!captured || !operatorScopeSatisfied("operator.cron", captured.authority.scopes)) {
    captured?.release();
    throw new Error(
      "Cron migration stage requires the staging caller's operator authority to rebind gateway-sourced automations",
    );
  }
  try {
    const defaultAgentId = caller.context.cron.getDefaultAgentId();
    const rebindOperatorSources = Object.fromEntries(
      sourced.map(({ job, original }) => {
        const agentId = tryResolveCronJobEffectiveAgentId(job, defaultAgentId);
        const fresh = agentId
          ? captureScheduledOperatorSource({
              authority: captured.authority,
              agentId,
              sourceRunId: randomUUID(),
              independent: true,
            })
          : undefined;
        if (!fresh || !job.operatorSource) {
          throw new Error(`Cron job ${job.id} could not be rebound to the staging operator`);
        }
        if (fresh.snapshot.profileId !== original.snapshot.profileId) {
          throw new Error(
            `Cron job ${job.id} belongs to another requester; recreate it from its own operator`,
          );
        }
        return [
          job.id,
          {
            source: narrowOperatorSourceToGrant(original, fresh),
            executionRevision: job.operatorSource.executionRevision,
          },
        ];
      }),
    );
    return {
      request: { ...request, rebindOperatorSources },
      assertCurrent: () => captured.authority.assertCurrent(),
      release: captured.release,
    };
  } catch (error) {
    captured.release();
    throw error;
  }
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
    if (request.phase === "stage-requester") {
      const captured = await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
      });
      try {
        assertCurrent();
        captured?.authority.assertCurrent();
        const stageRequesterProfileId =
          captured && operatorScopeSatisfied("operator.cron", captured.authority.scopes)
            ? (captured.authority.recoverySnapshot?.profileId ?? null)
            : null;
        respond(
          true,
          { ...request, agentIds: [], drained: true, stageRequesterProfileId },
          undefined,
        );
      } finally {
        captured?.release();
      }
      return;
    }
    const rebinding = await rebindStagedGatewaySources(request, {
      client,
      context,
      hasCurrentClientAuthority,
    });
    try {
      const result = await context.cron.migration(rebinding.request, () => {
        assertCurrent();
        rebinding.assertCurrent();
      });
      respond(true, result, undefined);
    } finally {
      rebinding.release();
    }
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
  }
};
