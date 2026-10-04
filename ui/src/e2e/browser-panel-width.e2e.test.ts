import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Browser panel default width" });

suite.define(() => {
  it.each([1440, 400])("keeps native takeover usable at %ipx", async (width) => {
    await suite.withPage(
      {
        viewport: { width, height: 900 },
        isMobile: width === 400,
        hasTouch: width === 400,
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.route("**/__openclaw__/assistant-media**", (route) =>
          route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          }),
        );
        const gateway = await installMockGateway(page, {
          featureMethods: ["browser.request"],
          operatorScopes: ["operator.admin"],
          methodResponses: {
            "browser.request": {
              cases: [
                {
                  match: { path: "/tabs" },
                  response: {
                    running: true,
                    tabs: [
                      {
                        targetId: "proof",
                        title: "Synthetic browser",
                        url: "https://example.com/",
                      },
                    ],
                  },
                },
                {
                  match: { path: "/screencast" },
                  response: {
                    __mockError: {
                      code: "UNAVAILABLE",
                      message: "Synthetic screenshot mode",
                      details: { code: "SCREENCAST_UNSUPPORTED" },
                    },
                  },
                },
                {
                  match: { path: "/screenshot" },
                  response: {
                    targetId: "proof",
                    path: "/synthetic.png",
                    url: "https://example.com/",
                  },
                },
                {
                  match: { path: "/act" },
                  response: {
                    result: {
                      cssWidth: 1440,
                      cssHeight: 900,
                      title: "Synthetic browser",
                      url: "https://example.com/",
                    },
                  },
                },
                ...[true, false].map((control) => ({
                  match: { path: "/control", body: { profile: "work", control } },
                  response: { controlled: control, owned: control, needsObservation: true },
                })),
              ],
            },
          },
        });
        await page.goto(
          `${suite.server.baseUrl}focus/browser?sessionKey=agent%3Amain%3Aproof&target=host&profile=work&targetId=proof`,
        );
        const panel = page.locator("openclaw-browser-panel");
        await panel.locator('.bp-shot[alt="Synthetic browser"]').waitFor();
        const take = panel.getByRole("button", {
          name: "Take control — pause agent input",
          exact: true,
        });
        await take.waitFor();
        expect(await take.getAttribute("aria-pressed")).toBe("false");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.screenshot({
          path: path.join(suite.artifactDir, `takeover-${width}-available.png`),
        });
        await gateway.deferNext("browser.request", { path: "/control" });
        await take.click();
        const acquired = await gateway.waitForRequest("browser.request", {
          match: { path: "/control" },
        });
        expect(acquired.params).toEqual({
          target: "host",
          method: "POST",
          path: "/control",
          body: { profile: "work", control: true },
        });
        expect(await take.isDisabled()).toBe(true);
        expect(await take.getAttribute("aria-busy")).toBe("true");
        await gateway.resolveDeferred("browser.request");
        const release = panel.getByRole("button", {
          name: "Release control — agent must observe again",
          exact: true,
        });
        await release.waitFor();
        expect(await release.getAttribute("aria-pressed")).toBe("true");
        await page.screenshot({
          path: path.join(suite.artifactDir, `takeover-${width}-owned.png`),
        });
        await release.click();
        await take.waitFor();
        expect(
          (
            await gateway.waitForRequest("browser.request", {
              match: { path: "/control", body: { profile: "work", control: false } },
            })
          ).params,
        ).toEqual({
          target: "host",
          method: "POST",
          path: "/control",
          body: { profile: "work", control: false },
        });
        expect(await take.getAttribute("aria-pressed")).toBe("false");
        await page.screenshot({
          path: path.join(suite.artifactDir, `takeover-${width}-released.png`),
        });
      },
    );
  });

  it.each([1200, 1440, 2048])(
    "uses the available pane at %ipx and preserves a resized width",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 1000 } }, async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["browser.request", "chat.metadata", "chat.startup"],
          historyMessages: [
            {
              role: "assistant",
              content: "Keep the conversation readable while browsing beside it.",
            },
          ],
          methodResponses: {
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: true, tabs: [] } },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        const region = page.locator(".sidebar-region");
        const browser = page.locator('[data-panel-slot="browser"]');
        const composer = page.locator(".agent-chat__composer-shell");
        const initialChatWidth = (await composer.boundingBox())!.width;
        await openChatSidePanelType(page, "Browser");
        await browser.waitFor();
        const paneWidth = (await region.boundingBox())!.width;
        const browserWidth = () =>
          browser.evaluate((element) => element.getBoundingClientRect().width);
        await expect.poll(browserWidth).toBeGreaterThan(paneWidth * 0.49);
        expect(await browserWidth()).toBeLessThanOrEqual(paneWidth * 0.6);
        if (paneWidth > 1_600) {
          expect((await composer.boundingBox())!.width).toBeCloseTo(initialChatWidth, 0);
        }
        await page.screenshot({ path: path.join(suite.artifactDir, `browser-${width}.png`) });
        const divider = page.getByRole("separator", { name: "Resize side panel" });
        const defaultWidth = await browserWidth();
        await divider.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(browserWidth).toBeLessThan(defaultWidth);
        const resizedWidth = await browserWidth();
        await page.reload();
        await browser.waitFor();
        await expect.poll(browserWidth).toBeCloseTo(resizedWidth, 0);
        await page.setViewportSize({ width: 400, height: 900 });
        await page.locator(".sidebar-region--narrow").waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
        await page.setViewportSize({ width, height: 1000 });
        await expect.poll(browserWidth).toBeCloseTo(resizedWidth, 0);
      });
    },
  );
});
