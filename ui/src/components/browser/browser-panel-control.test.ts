import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  setupBrowserPanelTestCleanup,
  TestBrowserPanelHost,
  flushBrowserResponses,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import { fakeNativeBrowser, nativeTab } from "./test-helpers/native-browser.ts";

function createControlledBrowserClient(acquisition?: Promise<unknown>) {
  return createBrowserClient(async (envelope) => {
    if (envelope.path === "/control") {
      if (envelope.body?.control && acquisition) {
        return acquisition;
      }
      return {
        controlled: envelope.body?.control,
        owned: envelope.body?.control,
        needsObservation: true,
      };
    }
    if (envelope.path === "/tabs") {
      return {
        running: true,
        tabs: [{ tabId: "tab-1", targetId: "tab-1", url: "https://example.test/page" }],
      };
    }
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: "tab-1", url: "https://example.test/page" };
    }
    if (envelope.path === "/act") {
      return { result: { cssWidth: 100, cssHeight: 100, url: "https://example.test/page" } };
    }
    return { ok: true };
  });
}

setupBrowserPanelTestCleanup();
describe("Browser panel operator control", () => {
  it("acquires the native profile and releases it when the view suspends", async () => {
    const { client, request } = createBrowserClient(async (envelope) => ({
      controlled: envelope.body?.control,
      owned: envelope.body?.control,
      needsObservation: true,
    }));
    const controller = createBrowserPanelTestController(client, "tab-1");
    controller.operations.resetRoute({ target: "host", profile: "openclaw" });
    await controller.operatorControl.toggle();
    expect(controller.operatorControl.owned).toBe(true);
    expect(request).toHaveBeenCalledWith("browser.request", {
      target: "host",
      method: "POST",
      path: "/control",
      body: { profile: "openclaw", control: true },
    });
    controller.suspendView();
    await flushBrowserResponses();
    expect(controller.operatorControl.owned).toBe(false);
    expect(request).toHaveBeenLastCalledWith("browser.request", {
      target: "host",
      method: "POST",
      path: "/control",
      body: { profile: "openclaw", control: false },
    });
  });
  it.each(["profile", "suspend-reopen"] as const)(
    "releases a late grant against its original connection after %s",
    async (change) => {
      const acquired = createDeferred<unknown>();
      const { client, request } = createBrowserClient(async (envelope) =>
        envelope.body?.control
          ? acquired.promise
          : { controlled: false, owned: false, needsObservation: true },
      );
      const host = new TestBrowserPanelHost(client);
      const controller = new BrowserPanelController(host);
      controller.operations.resetRoute({ target: "host", profile: "openclaw" });
      const pending = controller.operatorControl.toggle();
      if (change === "profile") {
        controller.operations.resetRoute({ target: "host", profile: "other" });
      } else {
        controller.suspendView();
      }
      acquired.resolve({ controlled: true, owned: true, needsObservation: true });
      await pending;
      expect(controller.operatorControl.owned).toBe(false);
      expect(request).toHaveBeenLastCalledWith("browser.request", {
        target: "host",
        method: "POST",
        path: "/control",
        body: { profile: "openclaw", control: false },
      });
    },
  );
  it("reports rejected control and keeps the original browser view", async () => {
    const { client } = createBrowserClient(async () => {
      throw new Error("Browser connection lost");
    });
    const controller = createBrowserPanelTestController(client, "tab-1");
    const view = controller.view;
    controller.operations.resetRoute({ target: "host", profile: "openclaw" });
    await controller.operatorControl.toggle();
    expect(controller.operatorControl.owned).toBe(false);
    expect(controller.operatorControl.busy).toBe(false);
    expect(controller.errorText).toContain("Browser connection lost");
    expect(controller.view).toBe(view);
  });
  it.each([false, true])(
    "releases host control when selecting a native tab (late grant: %s)",
    async (lateGrant) => {
      stubScreenshotMedia();
      const acquired = createDeferred<unknown>();
      const { client, request } = createControlledBrowserClient(
        lateGrant ? acquired.promise : undefined,
      );
      const controller = createBrowserPanelTestController(client, "tab-1");
      await controller.selectTab("tab-1", { target: "host", profile: "openclaw" });
      expect(controller.errorText).toBeNull();
      const pending = controller.operatorControl.toggle();
      if (!lateGrant) {
        await pending;
      }
      expect(controller.operatorControl.owned).toBe(!lateGrant);
      fakeNativeBrowser([nativeTab("mac-one")]);
      controller.hostConnected();
      try {
        await controller.selectTab("mac-one");
        acquired.resolve({ controlled: true, owned: true, needsObservation: true });
        await pending;
        await flushBrowserResponses();
        expect(controller.native.activeTab?.id).toBe("mac-one");
        expect(controller.operatorControl.available).toBe(false);
        expect(controller.operatorControl.owned).toBe(false);
        expect(request).toHaveBeenLastCalledWith("browser.request", {
          target: "host",
          method: "POST",
          path: "/control",
          body: { profile: "openclaw", control: false },
        });
      } finally {
        acquired.resolve({ controlled: true, owned: true, needsObservation: true });
        await pending;
        controller.hostDisconnected();
        await flushBrowserResponses();
      }
    },
  );
  it.each(["profile", "client"] as const)(
    "releases the captured owner through a public %s change",
    async (change) => {
      stubScreenshotMedia();
      const { client, request } = createControlledBrowserClient();
      const host = new TestBrowserPanelHost(client);
      const controller = new BrowserPanelController(host);
      controller.synchronizeClient();
      await controller.selectTab("tab-1", { target: "host", profile: "openclaw" });
      expect(controller.errorText).toBeNull();
      await controller.operatorControl.toggle();
      expect(controller.operatorControl.owned).toBe(true);
      request.mockClear();
      const replacement = createControlledBrowserClient();
      if (change === "client") {
        host.client = replacement.client;
        expect(controller.synchronizeClient()).toBe(true);
      } else {
        await controller.selectTab("tab-1", { target: "host", profile: "other" });
      }
      await flushBrowserResponses();
      expect(controller.operatorControl.owned).toBe(false);
      const controlRequests = request.mock.calls.filter(([, params]) => {
        return (params as { path?: string }).path === "/control";
      });
      expect(controlRequests).toEqual([
        [
          "browser.request",
          {
            target: "host",
            method: "POST",
            path: "/control",
            body: { profile: "openclaw", control: false },
          },
        ],
      ]);
      expect(replacement.request).not.toHaveBeenCalled();
    },
  );
  it("does not offer host control for an unrelated node browser", async () => {
    const { client, request } = createBrowserClient(async () => ({}));
    const controller = createBrowserPanelTestController(client, "tab-1");
    controller.operations.resetRoute({ target: "node", node: "other-node", profile: "openclaw" });
    expect(controller.operatorControl.available).toBe(false);
    await controller.operatorControl.toggle();
    expect(request).not.toHaveBeenCalled();
  });
});
