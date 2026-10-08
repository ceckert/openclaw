import type { OpenClawPluginGatewayEvents } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginStateKeyedStore,
  SessionEntryCurrentCheck,
} from "openclaw/plugin-sdk/plugin-state-runtime";
// Browser plugin runtime state shared across lazy bundles and duplicate SDK module instances.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type {
  BrowserDashboardDefinition,
  SessionBrowserDashboard,
} from "./browser-dashboard.types.js";
import type { ResolvedBrowserProfile } from "./browser/config.js";

type Requester = { connId: string; signal: AbortSignal; isCurrent(): boolean };
type BrowserOperatorControl = ReturnType<typeof createBrowserOperatorControl>;

export function createBrowserOperatorControl(profile: ResolvedBrowserProfile) {
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

export type BrowserDashboardOperation = {
  promise: Promise<unknown>;
  readonly materializationFailure?: {
    error: unknown;
    definition: BrowserDashboardDefinition;
    callerCancelled: boolean;
  };
};

export type BrowserDashboardRegistration = {
  kind: "dashboard-registration";
  targetId: string;
  profile: string | undefined;
  closeDispatched?: true;
};
export type BrowserSessionTabOperationKey = string | symbol | BrowserDashboardRegistration;

export type BrowserSessionTabAuthority = {
  runtime?: BrowserStateRuntime;
  assertCurrent?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
  dashboardRegistration?: BrowserDashboardRegistration;
};

export type BrowserStateRuntime = {
  sessionTabs: PluginStateKeyedStore<unknown>;
  sessionTabInitialization?: Promise<void>;
  sessionTabOperations: Map<BrowserSessionTabOperationKey, Promise<void>>;
  gateway?: PluginRuntime["gateway"];
  dashboardOperations: Map<string, BrowserDashboardOperation>;
  dashboardEvents?: OpenClawPluginGatewayEvents;
  sessionDashboards?: Map<string, SessionBrowserDashboard>;
  operatorControls?: Map<string, BrowserOperatorControl>;
};

const {
  setRuntime: setBrowserStateRuntime,
  getRuntime: getBrowserStateRuntime,
  tryGetRuntime: getOptionalBrowserStateRuntime,
} = createPluginRuntimeStore<BrowserStateRuntime>({
  pluginId: "browser",
  errorMessage: "Browser state runtime not initialized",
});

export { getBrowserStateRuntime, getOptionalBrowserStateRuntime, setBrowserStateRuntime };

export function assertBrowserSessionTabAuthority(authority: BrowserSessionTabAuthority) {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  if (getOptionalBrowserStateRuntime() !== runtime) {
    throw new Error("Browser session tab store owner changed");
  }
  authority.assertCurrent?.();
}

export function captureBrowserSessionTabAuthority(
  authority: BrowserSessionTabAuthority = {},
): BrowserSessionTabAuthority {
  return {
    ...authority,
    runtime: authority.runtime ?? getOptionalBrowserStateRuntime() ?? undefined,
  };
}

export function isBrowserStateRuntimeCurrent(
  runtime: BrowserStateRuntime | undefined,
  isCurrent?: () => boolean,
): boolean {
  return (!runtime || getOptionalBrowserStateRuntime() === runtime) && isCurrent?.() !== false;
}

export async function readCurrentBrowserState<T>(
  runtime: BrowserStateRuntime | undefined,
  read: () => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T | undefined> {
  if (!isBrowserStateRuntimeCurrent(runtime, isCurrent)) {
    return undefined;
  }
  try {
    const value = await read();
    return isBrowserStateRuntimeCurrent(runtime, isCurrent) ? value : undefined;
  } catch (error) {
    // Revoked preparation is discarded; accepted closes and writes still settle.
    if (!isBrowserStateRuntimeCurrent(runtime, isCurrent)) {
      return undefined;
    }
    throw error;
  }
}

export function getPendingBrowserDashboardRegistrations(
  runtime: BrowserStateRuntime,
  targetId: string | undefined,
  profile: string | undefined,
): Array<{ registration: BrowserDashboardRegistration; settled: Promise<void> }> {
  return [...runtime.sessionTabOperations].flatMap(([key, settled]) =>
    typeof key === "object" &&
    key.kind === "dashboard-registration" &&
    (!targetId || key.targetId === targetId) &&
    (!profile || key.profile === profile)
      ? [{ registration: key, settled }]
      : [],
  );
}
