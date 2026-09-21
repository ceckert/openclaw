import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/schema/approvals.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { capturePluginApprovalReviewerGuard } from "../infra/plugin-approval-reviewer.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";
import type { GatewayClient } from "./server-methods/types.js";

export class PluginApprovalReviewerError extends Error {
  constructor(cause: unknown) {
    super("plugin approval reviewer authority is unavailable", { cause });
    this.name = "PluginApprovalReviewerError";
  }
}

export function bindPluginApprovalReviewerGuard<TPayload>(
  record: ExecApprovalRecord<TPayload>,
): void {
  const guard = capturePluginApprovalReviewerGuard();
  if (!guard) {
    return;
  }
  record.reviewerGuardRequired = true;
  record.reviewerGuard = guard;
  record.approvalSignals = [...(record.approvalSignals ?? []), guard.signal];
  const priorAuthority = record.approvalAuthority;
  record.approvalAuthority = () => {
    guard.signal.throwIfAborted();
    guard.assertActive();
    return record.reviewerGuard === guard && priorAuthority?.() !== false;
  };
}

/** Ordinary authorization and channel custody must succeed before calling this narrower policy. */
export async function preparePluginApprovalReviewer(params: {
  record: Pick<ExecApprovalRecord, "reviewerGuardRequired" | "reviewerGuard"> | undefined;
  client: GatewayClient | null;
  decision: ExecApprovalDecision;
  reviewer?: ApprovalChannelReviewer;
  assertNativeAuthority: () => void;
}): Promise<(() => void) | null> {
  const record = params.record;
  if (!record?.reviewerGuardRequired) {
    return () => {};
  }
  const guard = record.reviewerGuard;
  if (!guard) {
    return null;
  }
  const deviceId = normalizeOptionalString(params.client?.connect?.device?.id);
  const profileId = normalizeOptionalString(params.client?.authenticatedUserProfile?.profileId);
  const userId = normalizeOptionalString(params.client?.authenticatedUserId);
  const channel =
    params.reviewer && params.client?.internal?.approvalRuntime === true
      ? {
          channel: params.reviewer.channel.trim().toLowerCase(),
          accountId: params.reviewer.accountId.trim(),
          senderId: params.reviewer.senderId.trim(),
        }
      : undefined;
  const assertActive = () => {
    params.assertNativeAuthority();
    params.client?.connectionSignal?.throwIfAborted();
    if (
      params.client?.invalidated ||
      (channel !== undefined && params.client?.internal?.approvalRuntime !== true) ||
      normalizeOptionalString(params.client?.connect?.device?.id) !== deviceId ||
      normalizeOptionalString(params.client?.authenticatedUserProfile?.profileId) !== profileId ||
      normalizeOptionalString(params.client?.authenticatedUserId) !== userId
    ) {
      throw new Error("plugin approval reviewer identity is no longer current");
    }
    if (record.reviewerGuard !== guard) {
      throw new Error("plugin approval reviewer authority is unavailable");
    }
    guard.signal.throwIfAborted();
    guard.assertActive();
  };
  assertActive();
  const prepared = await guard.prepare({
    decision: params.decision,
    ...(deviceId ? { deviceId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(userId ? { userId } : {}),
    ...(channel ? { channel } : {}),
  });
  assertActive();
  if (!prepared) {
    return null;
  }
  return () => {
    try {
      assertActive();
      prepared();
      assertActive();
    } catch (error) {
      throw new PluginApprovalReviewerError(error);
    }
  };
}
