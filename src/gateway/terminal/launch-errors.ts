import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { TerminalLaunchResolution } from "./launch.js";

export function terminalFailureMessage(message: string, hint?: string): string {
  return hint ? `${message}; ${hint}` : message;
}

export function terminalLaunchBlockedError(
  block: Extract<TerminalLaunchResolution, { ok: false }>["block"],
  hint?: string,
): ReturnType<typeof errorShape> {
  if (block.kind === "disabled") {
    return errorShape(ErrorCodes.UNAVAILABLE, terminalFailureMessage("terminal is disabled", hint));
  }
  if (block.kind === "unknown-agent") {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      terminalFailureMessage(`unknown agent "${block.agentId}"`, hint),
    );
  }
  if (block.kind === "owner-required") {
    return errorShape(ErrorCodes.INVALID_REQUEST, terminalFailureMessage(block.message, hint));
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    terminalFailureMessage(
      `terminal unavailable: agent "${block.agentId}" runs in a sandbox (mode "${block.mode}"); in-sandbox terminals are not supported yet`,
      hint,
    ),
  );
}
