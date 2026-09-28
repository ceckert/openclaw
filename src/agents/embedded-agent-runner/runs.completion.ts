import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  type EmbeddedRunCompletionClaim,
  type EmbeddedRunCompletionRegistration,
  type EmbeddedRunRegistration,
} from "./run-state.js";
import { isEmbeddedRunHandleInProgress } from "./runs.probes.js";

export function revokeCompletionClaim(sessionId: string, runId?: string): void {
  const claim = EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId);
  if (claim && (runId === undefined || claim.runId === runId)) {
    claim.settleRegistration(undefined);
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
  }
}

export function prepareEmbeddedAgentRunCompletionClaim(
  sessionId: string,
  runId: string,
): {
  bindOperationalRunInstance: (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ) => boolean;
  adoptActiveRun: () => boolean;
  claimCompletion: () => boolean;
  claimFailure: () => boolean;
  resolveCurrentRegistration: () => EmbeddedRunCompletionRegistration | undefined;
  registered: Promise<EmbeddedRunCompletionRegistration | undefined>;
} {
  let settleRegistration!: (registration: EmbeddedRunCompletionRegistration | undefined) => void;
  const registered = new Promise<EmbeddedRunCompletionRegistration | undefined>((resolve) => {
    settleRegistration = resolve;
  });
  const claim: EmbeddedRunCompletionClaim = {
    runId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    promoted: false,
    settleRegistration,
  };
  revokeCompletionClaim(sessionId);
  EMBEDDED_RUN_COMPLETION_CLAIMS.set(sessionId, claim);
  const consume = (allowUnregistered: boolean): boolean => {
    if (EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim) {
      return false;
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.delete(sessionId);
    if (!claim.promoted) {
      claim.settleRegistration(undefined);
    }
    return (
      (allowUnregistered || claim.promoted) &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    );
  };
  const bindOperationalRunInstance = (
    instance: NonNullable<EmbeddedRunRegistration["operationalRunInstance"]>,
  ): boolean => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration) ||
      instance.runId !== runId ||
      (claim.operationalRunInstance !== undefined && claim.operationalRunInstance !== instance)
    ) {
      return false;
    }
    claim.operationalRunInstance = instance;
    return true;
  };
  const resolveCurrentRegistration = (): EmbeddedRunCompletionRegistration | undefined => {
    if (
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim ||
      !isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
    ) {
      return undefined;
    }
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const toolAuthority = registration?.toolAuthority;
    if (
      !handle ||
      handle.runId !== runId ||
      !toolAuthority ||
      !claim.operationalRunInstance ||
      registration.operationalRunInstance !== claim.operationalRunInstance
    ) {
      return undefined;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      return undefined;
    }
    return EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) === claim &&
      ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration &&
      isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration)
      ? { toolAuthority }
      : undefined;
  };
  const adoptActiveRun = (): boolean => {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const instance = registration?.operationalRunInstance;
    const toolAuthority = registration?.toolAuthority;
    if (
      !handle ||
      handle.runId !== runId ||
      !isEmbeddedRunHandleInProgress(handle) ||
      !instance ||
      !toolAuthority ||
      !bindOperationalRunInstance(instance)
    ) {
      return false;
    }
    try {
      toolAuthority.assertActive();
    } catch {
      return false;
    }
    if (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      EMBEDDED_RUN_COMPLETION_CLAIMS.get(sessionId) !== claim
    ) {
      return false;
    }
    claim.promoted = true;
    claim.settleRegistration({ toolAuthority });
    return true;
  };
  return {
    bindOperationalRunInstance,
    adoptActiveRun,
    claimCompletion: () => consume(false),
    claimFailure: () => consume(true),
    resolveCurrentRegistration,
    registered,
  };
}
