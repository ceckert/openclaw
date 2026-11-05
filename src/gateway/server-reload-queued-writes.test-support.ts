import { assert, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createConfigReloadTestClock } from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import type {
  ManagedGatewayConfigReloaderHandle,
  ManagedGatewayConfigReloaderParams,
} from "./server-reload-contracts.js";
import {
  createConfigWriteNotification,
  createDirectConfigWriteFixture,
} from "./server-reload-handlers.config.test-support.js";

export function registerQueuedConfigWriteReloadTests({
  createConfig,
  installChannel,
  startManagedGatewayConfigReloader,
}: {
  createConfig: (changed?: boolean) => OpenClawConfig;
  installChannel: () => void;
  startManagedGatewayConfigReloader: (
    params: Pick<
      ManagedGatewayConfigReloaderParams,
      "initialConfig" | "readSnapshot" | "subscribeToWrites"
    > &
      Partial<ManagedGatewayConfigReloaderParams>,
  ) => ManagedGatewayConfigReloaderHandle;
}) {
  it.each([false, true])(
    "settles a channel write after startup drains, with an identical queued retry: %s",
    async (withRetry) => {
      const { clock, scheduler } = createConfigReloadTestClock();
      const initialConfig = createConfig();
      const nextConfig = { ...initialConfig, channels: createConfig(true).channels };
      installChannel();
      const writer = createDirectConfigWriteFixture(initialConfig);
      const watcher = installWatcherMock();
      const deferralStarted = createDeferred();
      const logReload = createInfoWarnErrorLogger();
      logReload.warn.mockImplementation((message: string) => {
        if (message.includes("deferring until")) {
          deferralStarted.resolve();
        }
      });
      const startChannel = vi.fn(async () => new Map());
      const stopChannel = vi.fn(async () => {});
      const reloader = startManagedGatewayConfigReloader({
        scheduler,
        initialConfig,
        readSnapshot: writer.readSnapshot,
        subscribeToWrites: writer.subscribeToWrites,
        logReload,
        startChannel,
        stopChannel,
      });
      await reloader.ready;
      const blocker = tryBeginGatewayRootWorkAdmission();
      const first = tryBeginGatewayRootWorkAdmission();
      let retry: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
      assert(blocker && first, "Expected admitted gateway request roots");
      const submit = async (root: NonNullable<typeof first>, revision: number) =>
        root.run(async () => {
          const continuation = captureGatewayRootWorkAdmissionContinuationScope();
          const application = createRuntimeConfigWriteApplication(
            continuation?.run,
            continuation ? { withWaitingRoot: continuation.runSync } : undefined,
          );
          writer.ref.current!(
            attachRuntimeConfigWriteApplication(
              createConfigWriteNotification(
                nextConfig,
                "retry-write",
                revision,
                "runtime",
                "source",
              ),
              application,
            ),
          );
          return application;
        });
      let firstOutcome: string | undefined;
      let retryOutcome: string | undefined;
      let oldReload: void | Promise<void> = undefined;
      let newReload: void | Promise<void> = undefined;
      vi.useFakeTimers();
      try {
        const original = await submit(first, 1);
        void original.result.then((outcome) => {
          firstOutcome = outcome;
          first.release();
        });
        oldReload = clock.wake();
        await deferralStarted.promise;
        if (withRetry) {
          retry = tryBeginGatewayRootWorkAdmission();
          assert(retry, "Expected retry request admission");
          const repeated = await submit(retry, 2);
          void repeated.result.then((outcome) => {
            retryOutcome = outcome;
            retry?.release();
          });
        }
        await vi.advanceTimersByTimeAsync(1000);
        expect(firstOutcome).toBeUndefined();
        expect(retryOutcome).toBeUndefined();
        expect(startChannel).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount({ excludeCurrent: true })).toBe(withRetry ? 3 : 2);
        blocker.release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(reloader.getDeferredChannelReloads?.()).toEqual([]);
        await oldReload;
        newReload = clock.wake();
        await vi.advanceTimersByTimeAsync(1000);
        await newReload;
        expect({ firstOutcome, retryOutcome }).toEqual({
          firstOutcome: "applied",
          retryOutcome: withRetry ? "applied" : undefined,
        });
        expect(startChannel).toHaveBeenCalledOnce();
        expect(stopChannel).toHaveBeenCalledOnce();
      } finally {
        blocker.release();
        first.release();
        retry?.release();
        const stopping = reloader.stop();
        await vi.advanceTimersByTimeAsync(500);
        await stopping;
        await Promise.all([oldReload, newReload]);
        watcher.restore();
      }
    },
  );
}
