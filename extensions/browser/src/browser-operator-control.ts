import {
  createBrowserOperatorControl,
  getOptionalBrowserStateRuntime,
} from "./browser-runtime-state.js";
import type { ResolvedBrowserProfile } from "./browser/config.js";

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
