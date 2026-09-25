import fs from "node:fs";
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
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { loadPreparedInboundPluginRegistry } from "./prepared-model-runtime.inbound-registry.js";
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
  cleanupPluginLoaderFixturesForTest();
});

it("reuses the active gateway registry across a secrets reload without recapturing plugins", async () => {
  const plugin = writePlugin({
    id: "secrets-reload-plugin",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { changed: { type: "boolean" } },
    },
    registration: "api.registerService({ id: 'probe', start() {}, stop() {} });",
  });
  const workspaceDir = makePluginLoaderTempDir();
  const env = process.env;
  const resolved = (apiKey: string): OpenClawConfig => ({
    plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] },
    models: { providers: { probe: { baseUrl: "http://probe.invalid", apiKey, models: [] } } },
  });
  const authored = resolved("${API_KEY}");
  const startupConfig = resolved("key-1");
  setRuntimeConfigSnapshot(startupConfig, authored);
  const metadata = loadPluginMetadataSnapshot({ config: startupConfig, env, workspaceDir });
  const loadContext = {
    ...resolvePluginRuntimeLoadContext({
      config: startupConfig,
      env,
      workspaceDir,
      metadataSnapshot: metadata,
    }),
    metadataSnapshot: metadata,
  };
  const registry = loadOpenClawPlugins({
    config: loadContext.config,
    activationSourceConfig: loadContext.activationSourceConfig,
    autoEnabledReasons: loadContext.autoEnabledReasons,
    workspaceDir,
    env,
    manifestRegistry: metadata.manifestRegistry,
    installRecords: loadContext.installRecords,
    activate: false,
    runtimeSideEffects: true,
    cache: false,
    runtimeOptions: { allowGatewaySubagentBinding: true },
  });
  setPluginRuntimeLoadContext(registry, loadContext);
  setActivePluginRegistry(registry, undefined, "gateway-bindable", workspaceDir);
  const record = registry.plugins.find((entry) => entry.id === plugin.id);
  expect(record?.status).toBe("loaded");
  expect(captures.count).toBe(1);
  const startupDigest = getPluginInstance(record!)?.sourceDigest;
  expect(startupDigest).toBeDefined();

  const rotated = resolved("key-2");
  setRuntimeConfigSnapshot(rotated, authored);
  const input = { config: rotated, workspaceDir, allowGatewaySubagentBinding: true };
  const reused = loadPreparedInboundPluginRegistry(
    input,
    prepareOwnedPluginLoadContext(input, env, undefined),
  );
  expect(reused).toBe(registry);
  expect(captures.count).toBe(1);

  fs.writeFileSync(
    plugin.file,
    "module.exports = { id: 'secrets-reload-plugin', register(api) { api.registerService({ id: 'probe-2', start() {}, stop() {} }); } };",
  );
  const edited = resolved("key-2");
  edited.plugins!.entries = { [plugin.id]: { config: { changed: true } } };
  const editedAuthored = resolved("${API_KEY}");
  editedAuthored.plugins!.entries = edited.plugins!.entries;
  setRuntimeConfigSnapshot(edited, editedAuthored);
  const editedInput = { config: edited, workspaceDir, allowGatewaySubagentBinding: true };
  const fresh = loadPreparedInboundPluginRegistry(
    editedInput,
    prepareOwnedPluginLoadContext(editedInput, env, undefined),
  );
  expect(fresh).not.toBe(registry);
  expect(captures.count).toBe(2);
  const freshRecord = fresh.plugins.find((entry) => entry.id === plugin.id);
  expect(getPluginInstance(freshRecord!)?.sourceDigest).not.toBe(startupDigest);
  for (const instance of [getPluginInstance(record!), getPluginInstance(freshRecord!)]) {
    expect((await instance!.dispose()).errors).toEqual([]);
  }
});
