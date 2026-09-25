import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ count: 0 }));
vi.mock("../plugins/plugin-generation-artifact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-generation-artifact.js")>();
  return {
    ...actual,
    capturePluginGenerationArtifact: (
      ...args: Parameters<typeof actual.capturePluginGenerationArtifact>
    ) => {
      captures.count += 1;
      return actual.capturePluginGenerationArtifact(...args);
    },
  };
});

import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import {
  advancePluginRuntimeLoadContextConfig,
  resolvePluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.resolve.js";
import { createPreparedInboundRegistryLoader } from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";

let previous: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  useNoBundledPlugins();
  previous = captureActivePluginRegistrySnapshot();
  captures.count = 0;
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(previous);
  resetPluginLoaderTestStateForTest();
  clearCurrentPluginMetadataSnapshot();
  clearPluginMetadataLifecycleCaches();
  cleanupPluginLoaderFixturesForTest();
});

it("converges every customer workspace on the Gateway registry across roster, binding, and secret commits", async () => {
  const plugin = writePlugin({
    id: "shared-gateway-plugin",
    registration: "api.registerService({ id: 'probe', start() {}, stop() {} });",
  });
  const gatewayWorkspaceDir = makePluginLoaderTempDir();
  const customerWorkspaceDirs = Array.from({ length: 4 }, () => makePluginLoaderTempDir());
  const env = process.env;
  const agentEntries = (count: number) =>
    Object.fromEntries(
      customerWorkspaceDirs
        .slice(0, count)
        .map((workspace, index) => [`customer-${index}`, { name: `Customer ${index}`, workspace }]),
    );
  const configFor = (apiKey: string, agentCount: number, bindings?: unknown[]): OpenClawConfig =>
    ({
      plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] },
      agents: { defaults: { workspace: gatewayWorkspaceDir }, entries: agentEntries(agentCount) },
      models: { providers: { probe: { baseUrl: "http://probe.invalid", apiKey, models: [] } } },
      ...(bindings ? { bindings } : {}),
    }) as OpenClawConfig;
  const startupConfig = configFor("key-1", 3);
  const startupSource = configFor("${API_KEY}", 3);
  setRuntimeConfigSnapshot(startupConfig, startupSource);
  const metadata = loadPluginMetadataSnapshot({ config: startupConfig, env });
  expect(metadata.workspaceDir).toBeUndefined();
  setGatewayPluginMetadataSnapshot(metadata, {
    config: startupSource,
    compatibleConfigs: [startupConfig],
    env,
    workspaceDir: gatewayWorkspaceDir,
  });
  const loadContext = {
    ...resolvePluginRuntimeLoadContext({
      config: startupConfig,
      activationSourceConfig: startupSource,
      env,
      workspaceDir: gatewayWorkspaceDir,
      metadataSnapshot: metadata,
    }),
    metadataSnapshot: metadata,
  };
  const registry = loadOpenClawPlugins({
    config: loadContext.config,
    activationSourceConfig: loadContext.activationSourceConfig,
    autoEnabledReasons: loadContext.autoEnabledReasons,
    workspaceDir: gatewayWorkspaceDir,
    env,
    manifestRegistry: metadata.manifestRegistry,
    installRecords: loadContext.installRecords,
    activate: false,
    runtimeSideEffects: true,
    cache: false,
    runtimeOptions: { allowGatewaySubagentBinding: true },
  });
  setPluginRuntimeLoadContext(registry, loadContext);
  setActivePluginRegistry(registry, undefined, "gateway-bindable", gatewayWorkspaceDir);
  const record = registry.plugins.find((entry) => entry.id === plugin.id);
  expect(record?.status).toBe("loaded");
  expect(captures.count).toBe(1);

  const converge = (config: OpenClawConfig, source: OpenClawConfig, agentCount: number) => {
    setRuntimeConfigSnapshot(config, source);
    const loadInboundRegistry = createPreparedInboundRegistryLoader();
    const registries = new Set<PluginRegistry>();
    for (const workspaceDir of [
      gatewayWorkspaceDir,
      ...customerWorkspaceDirs.slice(0, agentCount),
    ]) {
      const input = { config, workspaceDir, allowGatewaySubagentBinding: true };
      registries.add(
        loadInboundRegistry(input, prepareOwnedPluginLoadContext(input, env, undefined), undefined),
      );
    }
    return registries;
  };
  const commit = (config: OpenClawConfig, source: OpenClawConfig, agentCount: number) => {
    expect(advancePluginRuntimeLoadContextConfig(registry, config, source)).toBe(true);
    return converge(config, source, agentCount);
  };

  const customerInput = {
    config: startupConfig,
    workspaceDir: customerWorkspaceDirs[0]!,
    allowGatewaySubagentBinding: true,
  };
  expect(prepareOwnedPluginLoadContext(customerInput, env, undefined)).toBe(metadata);
  expect(converge(startupConfig, startupSource, 3)).toEqual(new Set([registry]));
  expect(captures.count).toBe(1);
  const created = configFor("key-1", 4);
  const createdSource = configFor("${API_KEY}", 4);
  expect(commit(created, createdSource, 4)).toEqual(new Set([registry]));
  const bindings = [{ agentId: "customer-3", match: { channel: "probe" } }];
  const bound = configFor("key-1", 4, bindings);
  const boundSource = configFor("${API_KEY}", 4, bindings);
  expect(commit(bound, boundSource, 4)).toEqual(new Set([registry]));
  expect(converge(configFor("key-2", 4, bindings), boundSource, 4)).toEqual(new Set([registry]));
  expect(captures.count).toBe(1);
  expect(getPluginRuntimeLoadContext(registry)?.workspaceDir).toBe(gatewayWorkspaceDir);
  expect((await getPluginInstance(record!)!.dispose()).errors).toEqual([]);
});
