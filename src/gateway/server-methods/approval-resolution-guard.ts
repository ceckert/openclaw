import type { ApprovalChannelReviewer } from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { prepareApprovalChannelCustody } from "../approval-channel-custody.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { canResolveOperatorApproval } from "../operator-approval-authorization.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import {
  isApprovalRecordVisibleToClient,
  type ApprovalRecordLookupResult,
  type prepareApprovalSessionAccess,
} from "./approval-record-lookup.js";
import type { ApprovalRequestAuthority } from "./approval-request-authority.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function createApprovalResolutionGuard<
  TPayload extends ExecApprovalRequestPayload | PluginApprovalRequestPayload,
>(
  params: {
    authority: ApprovalRequestAuthority;
    manager: ExecApprovalManager<TPayload>;
    client: GatewayClient | null;
    context: Pick<GatewayRequestContext, "getRuntimeConfig">;
    reviewer?: ApprovalChannelReviewer;
  },
  resolved: Extract<ApprovalRecordLookupResult<TPayload>, { ok: true }>,
  sessionAccess: Awaited<ReturnType<typeof prepareApprovalSessionAccess>>,
  custody: ReturnType<typeof prepareApprovalChannelCustody>,
): OperatorApprovalStoreGuard {
  const sourceSessionKey = resolved.snapshot.request.sessionKey;
  const sourceAgentId = resolved.snapshot.request.agentId;
  return {
    family: params.authority.guard.family,
    assertCurrent: () => {
      params.authority.assertCommitCurrent();
      if (
        params.manager.getLocalSnapshot(resolved.approvalId) !== resolved.snapshot ||
        resolved.snapshot.request.sessionKey !== sourceSessionKey ||
        resolved.snapshot.request.agentId !== sourceAgentId ||
        params.client?.invalidated ||
        (resolved.snapshot.reviewerGuardRequired && !canResolveOperatorApproval(params.client)) ||
        !isApprovalRecordVisibleToClient({
          record: resolved.snapshot,
          client: params.client,
          ...(params.authority.guard.family === "native-compatibility"
            ? { cfg: params.context.getRuntimeConfig(), sessionAccess }
            : {}),
        }) ||
        (params.reviewer && !custody?.isCurrent(resolved.snapshot))
      ) {
        throw new Error("approval resolver authority is no longer active");
      }
    },
  };
}
