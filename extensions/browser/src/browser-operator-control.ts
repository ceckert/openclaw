import { getOptionalBrowserStateRuntime } from "./browser-runtime-state.js";
import type { ResolvedBrowserProfile } from "./browser/config.js";

type Requester = { connId: string; signal: AbortSignal; isCurrent(): boolean };
export type BrowserOperatorControl = ReturnType<typeof createBrowserOperatorControl>;

function createBrowserOperatorControl(profile: ResolvedBrowserProfile) {
  let owner: Requester | undefined;
  let removeOwner: (() => void) | undefined;
  let closed = false;
  let needsObservation = false;
  let generation = 0;
  const observations = new WeakMap<object, number>();
  const inputs = new Set<AbortController>();
  const release = () => {
    removeOwner?.();
    removeOwner = undefined;
    if (owner) {
      owner = undefined;
      generation += 1;
      needsObservation = true;
    }
  };
  const currentOwner = () => {
    if (owner && (owner.signal.aborted || !owner.isCurrent())) {
      release();
    }
    return owner;
  };
  const status = (connId?: string) => ({
    controlled: Boolean(currentOwner()),
    owned: Boolean(owner && owner.connId === connId),
    needsObservation,
  });
  return {
    fingerprint: JSON.stringify(profile),
    status,
    set(control: boolean, requester: Requester) {
      requester.signal.throwIfAborted();
      if (closed || !requester.isCurrent()) {
        throw new Error("Browser operator connection is no longer current");
      }
      if (control) {
        release();
        owner = requester;
        generation += 1;
        needsObservation = true;
        const abort = () => {
          if (owner === requester) {
            release();
          }
        };
        requester.signal.addEventListener("abort", abort, { once: true });
        removeOwner = () => requester.signal.removeEventListener("abort", abort);
        for (const input of inputs) {
          input.abort(new Error("Browser input paused while the operator has control"));
        }
      } else if (currentOwner()?.connId === requester.connId) {
        release();
      } else if (owner) {
        throw new Error("Browser control belongs to another operator connection");
      }
      return status(requester.connId);
    },
    begin(input: boolean, observationOwner: object, signal?: AbortSignal) {
      const controller = new AbortController();
      const observedGeneration = generation;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (closed) {
          throw new Error("BROWSER_STALE_OBSERVATION: browser control owner changed");
        }
        if (input && currentOwner()) {
          throw new Error(
            "Browser input paused while the operator has control; release control in the Browser panel to resume",
          );
        }
        if (input && generation > 0 && observations.get(observationOwner) !== generation) {
          throw new Error(
            "BROWSER_STALE_OBSERVATION: take a fresh snapshot after the operator releases control",
          );
        }
        controller.signal.throwIfAborted();
      };
      assertCurrent();
      if (input) {
        inputs.add(controller);
      }
      return {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        assertCurrent,
        complete(observation: boolean) {
          if (
            observation &&
            !closed &&
            !signal?.aborted &&
            !currentOwner() &&
            generation === observedGeneration
          ) {
            needsObservation = false;
            observations.set(observationOwner, generation);
          }
        },
        release: () => {
          inputs.delete(controller);
        },
      };
    },
    dispose() {
      closed = true;
      release();
      for (const input of inputs) {
        input.abort(new Error("Browser control owner closed"));
      }
      inputs.clear();
    },
  };
}

export function resolveBrowserOperatorControl(profile: ResolvedBrowserProfile) {
  const runtime = getOptionalBrowserStateRuntime();
  if (!runtime) {
    return undefined;
  }
  const controls = (runtime.operatorControls ??= new Map());
  let control = controls.get(profile.name);
  if (control?.fingerprint !== JSON.stringify(profile)) {
    control?.dispose();
    control = createBrowserOperatorControl(profile);
    controls.set(profile.name, control);
  }
  return control;
}

const observationActions = new Set([
  "snapshot",
  "screenshot",
  "console",
  "requests",
  "errors",
  "text",
  "tabs",
  "status",
  "profiles",
  "doctor",
]);
export function beginBrowserOperatorOperation(
  action: string,
  profile: ResolvedBrowserProfile,
  signal?: AbortSignal,
  observationOwner: object = {},
) {
  const control = resolveBrowserOperatorControl(profile);
  return control?.begin(!observationActions.has(action), observationOwner, signal);
}
