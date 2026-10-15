import type { ExecApprovalDecision } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  sanitizeCodexApprovalVisibleText,
  type AppServerApprovalOutcome,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const PERSISTENT_APPROVAL_TARGET_MAX_LENGTH = 256;

export function readCommandActions(record: JsonObject | undefined): string[] {
  const actions = record?.commandActions;
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions
    .map((action) => (isJsonObject(action) ? readString(action, "command") : undefined))
    .filter((command): command is string => Boolean(command));
}

export function readPolicyCommand(record: JsonObject | undefined): string | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part): part is string => typeof part === "string")) {
    return command.join(" ");
  }
  return readCommandActions(record).join(" && ") || undefined;
}

type CommandRepeatedApproval =
  | { scope: "session"; decision: "acceptForSession" }
  | { scope: "persistent"; decision: JsonObject; description: string };

type CommandApprovalResolution =
  | CommandRepeatedApproval
  | { scope: "once"; decision: "accept" }
  | { scope: "denied"; decision: "decline" }
  | { scope: "cancelled"; decision: "cancel" };

export function resolveCommandApproval(
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): CommandApprovalResolution {
  if (outcome === "cancelled") {
    return { scope: "cancelled", decision: "cancel" };
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return { scope: "denied", decision: "decline" };
  }
  const capabilities = commandApprovalCapabilities(requestParams);
  if (outcome === "approved-session" && capabilities.repeated) {
    return capabilities.repeated;
  }
  return capabilities.once
    ? { scope: "once", decision: "accept" }
    : { scope: "denied", decision: "decline" };
}

export function commandApprovalAllowedDecisions(
  requestParams: JsonObject | undefined,
  requiresOneShot: boolean,
): ExecApprovalDecision[] | undefined {
  if (!Array.isArray(requestParams?.availableDecisions)) {
    return undefined;
  }
  const capabilities = commandApprovalCapabilities(requestParams);
  const decisions: ExecApprovalDecision[] = [];
  if (capabilities.once) {
    decisions.push("allow-once");
  }
  if (!requiresOneShot && capabilities.repeated) {
    decisions.push("allow-always");
  }
  decisions.push("deny");
  return decisions;
}

export function commandApprovalCapabilities(requestParams: JsonObject | undefined): {
  once: boolean;
  repeated?: CommandRepeatedApproval;
} {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return { once: true, repeated: { scope: "session", decision: "acceptForSession" } };
  }
  return {
    once: available.includes("accept"),
    repeated: available.includes("acceptForSession")
      ? { scope: "session", decision: "acceptForSession" }
      : findAvailableCommandPersistentApproval(available),
  };
}

function findAvailableCommandPersistentApproval(
  available: JsonValue[],
): CommandRepeatedApproval | undefined {
  for (const decision of available) {
    if (!isJsonObject(decision)) {
      continue;
    }
    const exec = decision.acceptWithExecpolicyAmendment;
    const network = decision.applyNetworkPolicyAmendment;
    const prefix = isJsonObject(exec) ? exec.execpolicy_amendment : undefined;
    const amendment = isJsonObject(network) ? network.network_policy_amendment : undefined;
    let target: string;
    if (
      Array.isArray(prefix) &&
      prefix.length > 0 &&
      prefix.every((part) => typeof part === "string")
    ) {
      target = `Command prefix: ${JSON.stringify(prefix)}`;
    } else if (
      isJsonObject(amendment) &&
      amendment.action === "allow" &&
      typeof amendment.host === "string" &&
      amendment.host.length > 0
    ) {
      target = `Network host: ${JSON.stringify(amendment.host)}`;
    } else {
      continue;
    }
    // A durable grant must show its complete target before the bounded command
    // preview. Keep one-shot approval when that target cannot be shown accurately.
    if (
      target.length > PERSISTENT_APPROVAL_TARGET_MAX_LENGTH ||
      sanitizeCodexApprovalVisibleText(target) !== target
    ) {
      continue;
    }
    return {
      scope: "persistent",
      decision,
      description: `Allow Always requests a persistent allow rule for future sessions.\n${target}`,
    };
  }
  return undefined;
}
