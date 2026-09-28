import { isComputerObservationAction } from "../../agents/tools/computer-tool-shared.js";

export type DesktopComputerControl = {
  isCurrent(): boolean;
  hasController(): boolean;
  onControlChanged(changed: (controlled: boolean) => void): () => void;
};

export function createDesktopComputerInputGuard(
  control: DesktopComputerControl,
  requireObservation = false,
) {
  let closed = false;
  let needsObservation = requireObservation || control.hasController();
  let generation = 0;
  const active = new Set<AbortController>();
  const unsubscribe = control.onControlChanged((controlled) => {
    needsObservation = true;
    generation += 1;
    if (controlled) {
      for (const controller of active) {
        controller.abort(new Error("Computer input paused while the operator has control"));
      }
    }
  });
  return {
    begin(command: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const action = typeof params.action === "string" ? params.action : undefined;
      const input =
        command === "computer.act" && !isComputerObservationAction(action, params.dialogAction);
      const controller = new AbortController();
      const observedGeneration = generation;
      const assertCurrent = () => {
        if (closed || !control.isCurrent()) {
          throw new Error("COMPUTER_STALE_OBSERVATION: desktop owner is no longer current");
        }
        if (input && control.hasController()) {
          throw new Error(
            "Computer input paused while the operator has control; release control in the Desktop panel to resume",
          );
        }
        if (input && needsObservation) {
          throw new Error(
            "COMPUTER_STALE_OBSERVATION: take a fresh screenshot after the operator releases control",
          );
        }
        controller.signal.throwIfAborted();
        signal?.throwIfAborted();
      };
      assertCurrent();
      if (input) {
        active.add(controller);
      }
      return {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        assertCurrent,
        complete() {
          if (
            command === "screen.snapshot" &&
            generation === observedGeneration &&
            !control.hasController() &&
            !closed &&
            !signal?.aborted &&
            control.isCurrent()
          ) {
            needsObservation = false;
          }
        },
        release() {
          active.delete(controller);
        },
      };
    },
    dispose() {
      closed = true;
      unsubscribe();
      for (const controller of active) {
        controller.abort(new Error("Computer desktop owner closed"));
      }
      active.clear();
    },
  };
}
