import path from "node:path";
import { expect, it } from "vitest";
import {
  matrixDiscoveryPlugin,
  pluginMethodResponses,
  pluginMethods,
} from "../pages/plugins/plugins.e2e.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin dialog recovery" });

suite.define(() => {
  it.each(["disconnected", "loading configuration"])(
    "dismisses an unsubmitted install review while %s",
    async (condition) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...pluginMethods, "config.get", "config.schema"],
          methodResponses: pluginMethodResponses(),
        });
        await page.goto(`${suite.server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
        const schemaReads = (await gateway.getRequests("config.schema")).length;
        if (condition === "loading configuration") {
          await gateway.deferNext("config.schema");
        }
        await page.getByRole("button", { name: "Install", exact: true }).click();
        const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
        await wizard.locator("dialog").waitFor({ state: "visible" });
        if (condition === "disconnected") {
          await gateway.setOnline(false);
          await gateway.closeLatest(1006, "synthetic disconnect");
          await expect
            .poll(() => page.locator("openclaw-router-outlet").getAttribute("aria-disabled"))
            .toBe("true");
        } else {
          await gateway.waitForRequest("config.schema", { after: schemaReads });
        }
        const cancel = wizard
          .locator("footer")
          .getByRole("button", { name: "Cancel", exact: true });
        const install = wizard.getByRole("button", { name: "Install Matrix", exact: true });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const output = createControlUiE2eArtifactDir(
            `plugin-dialog-${condition.replaceAll(" ", "-")}`,
          );
          await page.screenshot({ animations: "disabled", path: path.join(output, "review.png") });
        }
        expect(await cancel.isEnabled()).toBe(true);
        if (condition === "disconnected") {
          expect(await install.isEnabled()).toBe(false);
        }
        await cancel.click();
        await wizard.waitFor({ state: "detached" });
        expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
        if (condition === "loading configuration") {
          await gateway.resolveDeferred("config.schema");
          expect(await wizard.count()).toBe(0);
        }
      });
    },
  );

  it("keeps an active install owned and suppresses duplicate submits", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: pluginMethods,
        methodResponses: pluginMethodResponses(),
      });
      await page.goto(`${suite.server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
      await gateway.deferNext("plugins.install");
      await wizard
        .getByRole("button", { name: "Install Matrix", exact: true })
        .evaluate((element) => {
          const button = element as HTMLButtonElement;
          button.click();
          button.click();
        });
      await gateway.waitForRequest("plugins.install");
      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"))
        .toBe("installing");
      expect(await wizard.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      expect(await wizard.locator("dialog").isVisible()).toBe(true);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "Synthetic install failure",
      });
      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"))
        .toBe("error");
      await wizard.getByRole("button", { name: "Cancel", exact: true }).click();
      await wizard.waitFor({ state: "detached" });
    });
  });
});
