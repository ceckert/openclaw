import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { loadPreparedInboundPluginRegistry } from "./prepared-model-runtime.inbound-registry.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: vi.fn(() => createEmptyPluginRegistry()),
}));

const workspaceDir = "/gateway-workspace";
const configFor = (apiKey: SecretInput): OpenClawConfig => ({
  plugins: { entries: { demo: { enabled: true, config: { token: "plugin-token" } } } },
  models: { providers: { demo: { baseUrl: "https://example.invalid", apiKey, models: [] } } },
});
let previous: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  previous = captureActivePluginRegistrySnapshot();
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockClear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(previous);
});

function activate(
  config: OpenClawConfig,
  source = config,
  scope: { workspaceDir?: string } = { workspaceDir },
) {
  const registry = createEmptyPluginRegistry();
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
    ...scope,
  });
  setRuntimeConfigSnapshot(config, source);
  setPluginRuntimeLoadContext(registry, {
    rawConfig: config,
    config,
    activationSourceConfig: source,
    autoEnabledReasons: {},
    env: process.env,
    workspaceDir,
    metadataSnapshot,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    logger: { info() {}, warn() {}, error() {} },
  });
  setActivePluginRegistry(registry, undefined, "gateway-bindable", workspaceDir);
  const load = (candidate: OpenClawConfig, selectedWorkspace = workspaceDir) =>
    loadPreparedInboundPluginRegistry(
      { config: candidate, workspaceDir: selectedWorkspace, allowGatewaySubagentBinding: true },
      metadataSnapshot,
    );
  return { registry, metadataSnapshot, load };
}

it("borrows one config-wide Gateway registry without rebinding it to each agent workspace", () => {
  const config = configFor("initial");
  const { registry, load } = activate(config, config, {});
  for (const selectedWorkspace of [workspaceDir, "/other-agent-workspace", workspaceDir]) {
    expect(load(config, selectedWorkspace)).toBe(registry);
    expect(getPluginRuntimeLoadContext(registry)?.workspaceDir).toBe(workspaceDir);
  }
  expect(loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
});

it("reuses after external credential rotation but reloads changed SecretRefs and plugin config", () => {
  const source = configFor({ source: "env", provider: "default", id: "DEMO_KEY" });
  const { registry, load } = activate(configFor("initial"), source);
  const rotated = configFor("rotated");
  setRuntimeConfigSnapshot(rotated, source);
  expect(load(rotated)).toBe(registry);
  expect(loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();

  const changedPlugin = configFor("rotated");
  changedPlugin.plugins!.entries!.demo!.config = { token: "replacement-plugin-token" };
  setRuntimeConfigSnapshot(changedPlugin, source);
  expect(load(changedPlugin)).not.toBe(registry);

  const changedSource = configFor({ source: "env", provider: "default", id: "OTHER_KEY" });
  setRuntimeConfigSnapshot(rotated, changedSource);
  expect(load(rotated)).not.toBe(registry);
  expect(loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
});

it("keeps workspace-scoped metadata and explicit environments isolated from the Gateway", () => {
  const config = configFor("initial");
  for (const input of [
    { workspaceDir, env: { ...process.env } },
    { workspaceDir: "/other-workspace" },
  ]) {
    const { registry, metadataSnapshot } = activate(config, config, {
      workspaceDir: input.workspaceDir,
    });
    expect(
      loadPreparedInboundPluginRegistry(
        { config, ...input, allowGatewaySubagentBinding: true },
        metadataSnapshot,
      ),
    ).not.toBe(registry);
  }
  expect(loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
});
