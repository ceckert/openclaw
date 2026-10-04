import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestBrowserOperatorControl } from "./browser-client.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";

export class BrowserPanelOperatorControl {
  owned = false;
  busy = false;
  private owner?: { client: GatewayBrowserClient; profile: string };
  private generation = 0;

  constructor(private readonly panel: BrowserPanelController) {}

  get available(): boolean {
    return (
      this.panel.operations.route?.target === "host" &&
      !this.panel.host.dashboardTarget &&
      !this.panel.native.activeTab
    );
  }

  async toggle(): Promise<void> {
    const { host, operations } = this.panel;
    const route = operations.route;
    const client = host.client;
    if (!this.available || !client || !route || this.busy) {
      return;
    }
    const owner = { client, profile: route.profile };
    const generation = this.generation;
    this.busy = true;
    host.requestUpdate();
    try {
      const result = await requestBrowserOperatorControl(client, route.profile, !this.owned);
      const current =
        generation === this.generation &&
        this.available &&
        host.client === client &&
        operations.route === route &&
        host.isConnected &&
        host.browserPanelIsOpen();
      if (!current) {
        if (result.owned) {
          await requestBrowserOperatorControl(client, route.profile, false);
        }
        return;
      }
      this.owner = result.owned ? owner : undefined;
      this.owned = result.owned;
    } catch (error) {
      this.panel.reportError(error);
    } finally {
      this.busy = false;
      host.requestUpdate();
    }
  }

  async release(): Promise<void> {
    this.generation += 1;
    const owner = this.owner;
    this.owner = undefined;
    this.owned = false;
    this.panel.host.requestUpdate();
    if (owner) {
      try {
        await requestBrowserOperatorControl(owner.client, owner.profile, false);
      } catch (error) {
        this.panel.reportError(error);
      }
    }
  }
}
