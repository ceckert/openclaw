import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";

describe("account-scoped SecretRef reload planning", () => {
  const mattermostPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "mattermost",
      config: {
        listAccountIds: (cfg) => Object.keys(cfg.channels?.mattermost?.accounts ?? {}),
      },
    }),
    reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
  };

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    {
      label: "inspects unresolved account secrets",
      inspect: "available",
      resolveFails: true,
      scoped: true,
    },
    {
      label: "promotes failed inspection without strict fallback",
      inspect: "throws",
      resolveFails: false,
      scoped: false,
    },
    {
      label: "resolves plugins without inspection",
      inspect: "absent",
      resolveFails: false,
      scoped: true,
    },
    {
      label: "promotes failed resolution without inspection",
      inspect: "absent",
      resolveFails: true,
      scoped: false,
    },
  ])("$label", ({ inspect, resolveFails, scoped }) => {
    const resolveAccount = vi.fn(() => {
      if (resolveFails) {
        throw new Error("SecretRef is unresolved in source config");
      }
      return {};
    });
    const inspectAccount = vi.fn(() => {
      if (inspect === "throws") {
        throw new Error("Invalid account configuration");
      }
      return { configured: true, botTokenStatus: "configured_unavailable" };
    });
    const plugin: ChannelPlugin = {
      ...mattermostPlugin,
      config: {
        ...mattermostPlugin.config,
        resolveAccount,
        ...(inspect === "absent" ? {} : { inspectAccount }),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));
    const plan = buildGatewayReloadPlan(["channels.mattermost.accounts.alpha.botToken"], {
      candidateConfig: {
        channels: {
          mattermost: {
            accounts: {
              alpha: { botToken: { source: "env", provider: "default", id: "BOT_TOKEN" } },
              beta: { enabled: true },
            },
          },
        },
      } as OpenClawConfig,
    });
    expect(plan.restartChannels).toEqual(new Set(scoped ? [] : ["mattermost"]));
    expect(plan.restartChannelAccounts).toEqual(
      new Map(scoped ? [["mattermost", new Set(["alpha"])]] : []),
    );
    if (inspect !== "absent") {
      expect(resolveAccount).not.toHaveBeenCalled();
    }
  });
});
