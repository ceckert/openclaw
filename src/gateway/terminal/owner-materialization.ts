import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { executeSessionPatch } from "../server-methods/sessions-patch-engine.js";
import type { GatewayClient, GatewayRequestContext } from "../server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { terminalFailureMessage, terminalLaunchBlockedError } from "./launch-errors.js";
import type { TerminalLaunchPlan } from "./launch.js";
import { TerminalOpenDeadlineError, waitForTerminalOpenDeadline } from "./open-deadline.js";

type TerminalOpenDeadline = {
  expiresAtMs: number;
  controller: AbortController;
};

type CurrentLaunch = { ok: true; plan: TerminalLaunchPlan } | { ok: false; error: ErrorShape };

type MaterializationState = {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  connId: string;
  agentSessionKey: string;
  requestedAgentId: string;
  deadline: TerminalOpenDeadline;
  failureHint?: string;
};

function agentChangedError(hint?: string): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    terminalFailureMessage("terminal agent changed while opening; refresh and retry", hint),
  );
}

function resolveCurrentLaunch(input: {
  context: GatewayRequestContext;
  requestedAgentId: string;
  failureHint?: string;
}): CurrentLaunch {
  if (!input.context.isTerminalEnabled()) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal is disabled", input.failureHint),
      ),
    };
  }
  const launch = input.context.resolveTerminalLaunchPolicy(input.requestedAgentId);
  if (!launch.ok) {
    return {
      ok: false,
      error: terminalLaunchBlockedError(launch.block, input.failureHint),
    };
  }
  if (launch.plan.agentId !== input.requestedAgentId) {
    return { ok: false, error: agentChangedError(input.failureHint) };
  }
  return launch;
}

function resolveMaterializationState(input: MaterializationState): CurrentLaunch {
  if (input.deadline.controller.signal.aborted || Date.now() >= input.deadline.expiresAtMs) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal open timed out", input.failureHint),
      ),
    };
  }
  if (input.context.isConnectionActive?.(input.connId) === false) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal connection closed", input.failureHint),
      ),
    };
  }
  return resolveCurrentLaunch(input);
}

export async function materializeTerminalAgentOwner(input: MaterializationState): Promise<
  | {
      ok: true;
      agentSessionKey: string;
      agentSessionId: string;
      launchPlan: TerminalLaunchPlan;
    }
  | { ok: false; error: ErrorShape }
> {
  const assertMaterializationCurrent = () => {
    const current = resolveMaterializationState(input);
    if (!current.ok) {
      throw new SessionMutationAuthorizationChangedError(current.error);
    }
  };

  let patched: Awaited<ReturnType<typeof executeSessionPatch>>;
  try {
    patched = await waitForTerminalOpenDeadline(
      () =>
        executeSessionPatch({
          client: input.client,
          context: input.context,
          patch: { key: input.agentSessionKey, agentId: input.requestedAgentId },
          sessionMutationAuthorization: {
            assertCurrent: assertMaterializationCurrent,
            assertTargetCurrent: assertMaterializationCurrent,
          },
        }),
      input.deadline,
    );
  } catch (error) {
    if (error instanceof TerminalOpenDeadlineError) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          terminalFailureMessage("terminal open timed out", input.failureHint),
        ),
      };
    }
    throw error;
  }
  if (!patched.ok) {
    return patched;
  }

  const patchedSessionId = patched.result.entry.sessionId?.trim();
  if (!patchedSessionId) {
    throw new Error("sessions.patch materialized a terminal owner without a sessionId");
  }
  const { entry } = loadGatewaySessionEntryReadOnly(patched.result.key, {
    agentId: input.requestedAgentId,
    clone: false,
  });
  const readinessError = resolveSessionWorkStartError(patched.result.key, entry, {
    expectedSessionId: patchedSessionId,
  });
  if (readinessError) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        terminalFailureMessage(readinessError, input.failureHint),
      ),
    };
  }
  const finalLaunch = resolveMaterializationState(input);
  if (!finalLaunch.ok) {
    return finalLaunch;
  }
  return {
    ok: true,
    agentSessionKey: patched.result.key,
    agentSessionId: patchedSessionId,
    launchPlan: finalLaunch.plan,
  };
}
