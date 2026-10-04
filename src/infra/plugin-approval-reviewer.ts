import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

/** Identity supplied by the Gateway after its ordinary reviewer authorization. */
export type PluginApprovalReviewer = Readonly<{
  decision: ExecApprovalDecision;
  deviceId?: string;
  profileId?: string;
  userId?: string;
  channel?: Readonly<{ channel: string; accountId: string; senderId: string }>;
}>;

/** Additional, process-local authority for one plugin approval; never RPC input. */
export type PluginApprovalReviewerGuard = Readonly<{
  signal: AbortSignal;
  assertActive: () => void;
  /** Null leaves the request pending. The returned repeatable guard checks current authority synchronously. */
  prepare: (reviewer: PluginApprovalReviewer) => Promise<(() => void) | null>;
}>;

type ReviewerScope = { guard: PluginApprovalReviewerGuard; captured: boolean };
const scope = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginApprovalReviewerScope"),
  () => new AsyncLocalStorage<ReviewerScope>(),
);

function assertActive(guard: PluginApprovalReviewerGuard): void {
  guard.signal.throwIfAborted();
  guard.assertActive();
}

/** Bind one in-process Gateway approval request to a live plugin-owned reviewer policy. */
export async function withPluginApprovalReviewerGuard<T>(
  guard: PluginApprovalReviewerGuard,
  run: () => Promise<T>,
): Promise<T> {
  if (scope.getStore()) {
    throw new Error("plugin approval reviewer scopes cannot be nested");
  }
  assertActive(guard);
  const binding: ReviewerScope = { guard, captured: false };
  const result = await scope.run(binding, run);
  assertActive(guard);
  if (!binding.captured) {
    throw new Error("plugin approval reviewer guard requires one in-process Gateway request");
  }
  return result;
}

export function capturePluginApprovalReviewerGuard(): PluginApprovalReviewerGuard | undefined {
  const binding = scope.getStore();
  if (!binding) {
    return undefined;
  }
  assertActive(binding.guard);
  if (binding.captured) {
    throw new Error("plugin approval reviewer guard already bound to an approval");
  }
  binding.captured = true;
  return binding.guard;
}
