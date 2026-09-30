import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "../plugins/hooks.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryGatewayOwner,
  getPluginRegistryGatewayOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { RuntimePluginLoadPurpose } from "./harness/runtime-plugin-load-plan.js";
import {
  createPreparedInboundRegistryLoader,
  loadPreparedInboundPluginRegistry,
  prepareWorkspacePluginRegistries,
} from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { inspection: false, selectedAtStartup: true, purpose: "agent", omitWorkspace: false },
  { inspection: false, selectedAtStartup: true, purpose: "agent", omitWorkspace: true },
  { inspection: true, selectedAtStartup: true, purpose: "agent" },
  { inspection: false, selectedAtStartup: false, purpose: "agent" },
  { inspection: true, selectedAtStartup: true, purpose: "model-catalog" },
] satisfies Array<{
  inspection: boolean;
  selectedAtStartup: boolean;
  purpose: RuntimePluginLoadPurpose;
  omitWorkspace?: boolean;
}>)(
  "borrows startup captures only for admitted selected owners ($inspection, $selectedAtStartup, $purpose, $omitWorkspace)",
  async ({ inspection, selectedAtStartup, purpose, omitWorkspace }) => {
    useNoBundledPlugins();
    const workspaceDir = tempDirs.make("openclaw-prepared-startup-workspace-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-startup-state-"));
    const event = `startup-capture:${workspaceDir}`;
    const captures: string[] = [];
    const onCapture = (directory: string) => captures.push(directory);
    process.on(event, onCapture);
    using _ = { [Symbol.dispose]: () => process.off(event, onCapture) };
    const plugin = writePlugin({
      id: "selected-provider",
      dir: tempDirs.make("openclaw-prepared-startup-plugin-"),
      registration: `process.emit(${JSON.stringify(event)}, __dirname);
        api.registerProvider({ id: "selected", label: "Selected", auth: [] });`,
    });
    const manifestFile = path.join(plugin.dir, "openclaw.plugin.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifestFile, "utf8")),
        providers: ["selected"],
      }),
    );
    const config: OpenClawConfig = {
      agents: { defaults: { model: "selected/model" } },
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: { [plugin.id]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    const input = {
      config,
      workspaceDir: omitWorkspace
        ? tempDirs.make("openclaw-prepared-agent-workspace-")
        : workspaceDir,
      agentDir: workspaceDir,
      allowGatewaySubagentBinding: true,
      runtimePluginSelections: [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
    };
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const metadata = loadPluginMetadataSnapshot({
        config,
        ...(omitWorkspace ? {} : { workspaceDir }),
      });
      const root = loadAndActivateRootPluginRegistry({
        config,
        workspaceDir,
        manifestRegistry: metadata.manifestRegistry,
        discovery: metadata.discovery,
        onlyPluginIds: selectedAtStartup ? [plugin.id] : [],
        runtimeOptions: { allowGatewaySubagentBinding: true },
        cache: false,
        throwOnLoadError: true,
      });
      prepareOwnedPluginLoadContext({ ...input, workspaceDir }, process.env, root, metadata, true);
      const gatewayOwner = { current: () => root };
      bindPluginRegistryGatewayOwner(root, gatewayOwner);
      const resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
      const loadInbound = createPreparedInboundRegistryLoader();
      let selected: PluginRegistry | undefined;
      try {
        expect(root.plugins).toEqual(
          selectedAtStartup ? [expect.objectContaining({ id: plugin.id, status: "loaded" })] : [],
        );
        expect(captures).toHaveLength(selectedAtStartup ? 1 : 0);
        const startupCapture = captures[0];
        const prepared = await withPluginRuntimeRegistryScope(root, () =>
          prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => resources.retainRegistry(registry),
            loadInbound,
            true,
            undefined,
            () => [],
            undefined,
            inspection ? resources.load.bind(resources) : undefined,
            purpose,
          ),
        );
        selected = prepared.runtimePluginRegistry;
        expect(prepared.inboundPluginRegistry === root).toBe(purpose === "agent");
        expect(getPluginRuntimeLoadContext(root)?.workspaceDir).toBe(workspaceDir);
        expect(captures).toHaveLength(1);
        expect(captures[0]).not.toBe(plugin.dir);
        const reused = purpose === "agent" && selectedAtStartup;
        expect(selected === root).toBe(reused);
        expect(prepared.primaryRegistry === root).toBe(reused);
        expect(selected?.providers.map(({ provider }) => provider.id)).toEqual(
          purpose === "agent" ? ["selected"] : [],
        );
        if (purpose === "agent") {
          expect(getPluginRegistryGatewayOwner(selected!)).toBe(gatewayOwner);
        }
        await resources[Symbol.asyncDispose]();
        expect(getActivePluginRegistry() === root).toBe(true);
        if (startupCapture) {
          expect(captures).toEqual([startupCapture]);
          expect(fs.existsSync(startupCapture)).toBe(true);
        }
      } finally {
        await resources[Symbol.asyncDispose]();
        if (selected && selected !== root) {
          await disposePluginRegistryInstances(selected);
        }
        await disposePluginRegistryInstances(root);
      }
      expect(captures.every((directory) => !fs.existsSync(directory))).toBe(true);
      if (purpose === "agent") {
        await using retiredBuild = new PreparedModelRuntimeBuildResources(
          retainPreparedPluginRegistry,
        );
        expect(() =>
          prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => retiredBuild.retainRegistry(registry),
            loadInbound,
            true,
          ),
        ).toThrow(/retired|reloaded or disabled/);
        expect(captures).toHaveLength(1);
      }
    });
  },
);

it.each(["inbound", "selected", "inspection"] as const)(
  "borrows hooks only from the admitting Gateway through %s preparation",
  async (producer) => {
    useNoBundledPlugins();
    const workspaceDir = tempDirs.make("openclaw-prepared-owner-workspace-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-owner-state-"));
    const calls: object[] = [];
    const registrations: object[] = [];
    const event = `borrow-owner:${workspaceDir}`;
    const onCall = (owner: object) => calls.push(owner);
    const onRegister = (owner: object) => registrations.push(owner);
    process.on(event, onCall);
    process.on(`${event}:register`, onRegister);
    using _ = {
      [Symbol.dispose]: () => {
        process.off(event, onCall);
        process.off(`${event}:register`, onRegister);
      },
    };
    const plugin = writePlugin({
      id: "owned-hook",
      registration:
        `const owner = {};
        process.emit(${JSON.stringify(`${event}:register`)}, owner);
        api.on("before_prompt_build", () => {
          process.emit(` +
        JSON.stringify(event) +
        `, owner);
          return { prependContext: "owned hook" };
        });`,
    });
    const config: OpenClawConfig = {
      agents: { defaults: { model: "selected/model" } },
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
        slots: { memory: "none" },
      },
    };
    const input = {
      config,
      workspaceDir,
      agentDir: workspaceDir,
      allowGatewaySubagentBinding: true,
    };
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const metadata = loadPluginMetadataSnapshot({ config });
      const loadGateway = () => {
        const registry = loadAndActivateRootPluginRegistry({
          config,
          workspaceDir,
          manifestRegistry: metadata.manifestRegistry,
          discovery: metadata.discovery,
          onlyPluginIds: [plugin.id],
          channelPluginLoadIntent: "full",
          runtimeOptions: { allowGatewaySubagentBinding: true },
          cache: false,
          throwOnLoadError: true,
        });
        prepareOwnedPluginLoadContext(input, process.env, registry, metadata, true);
        return createPluginRegistryOwner(registry, workspaceDir);
      };
      const a = loadGateway();
      const b = loadGateway();
      const ambiguous = createEmptyPluginRegistry();
      ambiguous.plugins.push(...a.registry.plugins);
      bindPluginRegistryGatewayOwner(ambiguous, getPluginRegistryGatewayOwner(a.registry)!);
      bindPluginRegistryGatewayOwner(ambiguous, getPluginRegistryGatewayOwner(b.registry)!);
      const closing = createEmptyPluginRegistry();
      closing.plugins.push(...a.registry.plugins);
      bindPluginRegistryGatewayOwner(closing, { current: () => undefined });
      const run = async (
        request: PluginRegistry | undefined,
        borrowed: boolean,
        selectedMetadata = metadata,
      ) => {
        await using resources = new PreparedModelRuntimeBuildResources(
          retainPreparedPluginRegistry,
        );
        const registry = await withPluginRuntimeRegistryScope(request, async () => {
          if (producer === "inbound") {
            const loaded = loadPreparedInboundPluginRegistry(input, selectedMetadata);
            resources.retainRegistry(loaded);
            return loaded;
          }
          const prepared = await prepareWorkspacePluginRegistries(
            input,
            selectedMetadata,
            (value) => resources.retainRegistry(value),
            undefined,
            true,
            undefined,
            () => [],
            [plugin.id],
            producer === "inspection" ? resources.load.bind(resources) : undefined,
          );
          return prepared.runtimePluginRegistry;
        });
        expect(registry).toBeDefined();
        if (!registry) {
          throw new Error("Expected a prepared registry");
        }
        const result = await createHookRunner(registry, {
          catchErrors: false,
        }).runBeforePromptBuild({ prompt: "probe", messages: [] }, {});
        expect.soft(result?.prependContext).toBe("owned hook");
        const invoked = calls.splice(0);
        expect.soft(invoked).toHaveLength(1);
        expect.soft(invoked[0] === registrations[0]).toBe(borrowed);
        expect.soft(invoked[0]).not.toBe(registrations[1]);
        expect.soft(registry.plugins[0] === a.registry.plugins[0]).toBe(borrowed);
        expect.soft(registry.plugins[0]).not.toBe(b.registry.plugins[0]);
      };
      try {
        expect(getActivePluginRegistry()).toBe(b.registry);
        await run(a.registry, true);
        await run(
          a.registry,
          false,
          loadPluginMetadataSnapshot({
            config,
            workspaceDir: tempDirs.make("openclaw-prepared-other-workspace-"),
          }),
        );
        await run(undefined, false);
        await run(ambiguous, false);
        await run(closing, false);
      } finally {
        await b.close();
        await a.close();
      }
    });
  },
);
