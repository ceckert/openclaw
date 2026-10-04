import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  setupBrowserPanelTestCleanup,
  TestBrowserPanelHost,
  flushBrowserResponses,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

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
  it("does not offer host control for an unrelated node browser", async () => {
    const { client, request } = createBrowserClient(async () => ({}));
    const controller = createBrowserPanelTestController(client, "tab-1");
    controller.operations.resetRoute({ target: "node", node: "other-node", profile: "openclaw" });
    expect(controller.operatorControl.available).toBe(false);
    await controller.operatorControl.toggle();
    expect(request).not.toHaveBeenCalled();
  });
});
