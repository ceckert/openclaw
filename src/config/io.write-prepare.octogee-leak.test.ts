/**
 * Octogee fork — regression coverage for the SIGUSR1-on-mount cascade.
 *
 * On TEST 2026-04-27 (Octogee gateway, v2026.4.24+), every customer-mount
 * config.patch triggered a full gateway SIGUSR1 restart. The reloader's
 * `applySnapshot` log showed `plugins.entries.{id}.config.*` paths in the
 * diff that the customer-mount patch did NOT touch, matching the
 * `{ prefix: "plugins", kind: "restart" }` rule in config-reload-plan.ts.
 *
 * Root cause:
 *
 *   1. `resolvePersistCandidateForWrite` correctly strips runtime defaults
 *      out of the persisted source. The on-disk source file is clean.
 *      (Tests "Shape A/B/C" below pin this contract.)
 *
 *   2. BUT the outer `writeConfigFile` notification was sending `nextCfg`
 *      to listeners — i.e. the in-memory merge result against
 *      `runtimeConfigSourceSnapshot`. `prepareSecretsRuntimeSnapshot`
 *      (secrets/runtime.ts:271-272) populates that source snapshot by
 *      `structuredClone(params.config)` — using the validated RUNTIME
 *      config (defaults included) for BOTH source and runtime slots.
 *      So `nextCfg` carries the AJV-injected defaults forward even
 *      though the disk file does not.
 *
 *   3. The gateway config reloader stashes
 *      `pendingInProcessConfig.compareConfig = event.sourceConfig` and
 *      diffs it against `currentCompareConfig` (initialized at boot
 *      from `startupLastGoodSnapshot.sourceConfig`, which IS raw
 *      pre-validation source). Result: every in-process write
 *      surfaces all the AJV defaults as "newly added" `plugins.*`
 *      paths → restart classifier escalates to SIGUSR1 → 30s downtime
 *      per customer mount.
 *
 * Octogee fork patch (this file is the regression test):
 *   - Inner writeConfigFile now exposes `persistedSourceView`:
 *     persistCandidate captured AFTER AJV-default stripping (via
 *     resolvePersistCandidateForWrite) but BEFORE env-ref restoration.
 *   - Outer writeConfigFile uses persistedSourceView for both
 *     event.sourceConfig (notification) and nextSourceConfig
 *     (source-snapshot refresh).
 *
 * persistedSourceView preserves the upstream invariant that listeners
 * see resolved env refs / secrets (existing test "notifies in-process
 * reloaders with resolved source config when persisted env refs are
 * restored" still passes), while filtering out the plugin defaults
 * that aren't actually on disk — so the reloader's compareConfig diff
 * stops surfacing `plugins.*` paths on every customer-mount write.
 *
 * Test "outer writeConfigFile notify gap" exercises the fix end-to-end:
 *   - Disk source has `octogee-router.config = {}` (no defaults).
 *   - Snapshot pair is set with both slots polluted by AJV defaults
 *     (mirroring the boot pollution).
 *   - A customer-mount writeConfigFile fires.
 *   - Disk file stays clean (was always working).
 *   - event.sourceConfig matches the disk file (was the bug, now fixed).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);
const mockMaintainConfigBackups = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(async () => {}),
);

vi.mock(import("../plugins/manifest-registry.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  return {
    ...actual,
    maintainConfigBackups: mockMaintainConfigBackups,
  };
});

describe("Octogee plugin-entry default leak repro", () => {
  // Helper: a runtime config that mimics what AJV produces after
  // applying schema defaults to plugins.entries.octogee-router.config.
  // (See infra/gateway/extensions/octogee-router/openclaw.plugin.json
  // in the Octogee repo: "default" declared on every config field.)
  const runtimeWithAjvDefaults = (sourceShape: Record<string, unknown>) => ({
    gateway: { mode: "local" },
    plugins: {
      enabled: true,
      allow: ["mattermost", "octogee-router", "octogee-mattermost-tools"],
      entries: {
        ...sourceShape,
        // The AJV-injected defaults always appear on the runtime side:
        "octogee-router": {
          enabled: true,
          config: {
            enforcement: "observe", // ← AJV default
            advisorySlugs: [], // ← AJV default
            enforcementOverrides: {}, // ← AJV default
            faceModelOverrides: {}, // ← AJV default
            brainModelOverrides: {}, // ← AJV default
          },
        },
      },
    },
  });

  // The customer-mount patch the Octogee provisioner applies.
  // ONLY agents.list / bindings / channels.mattermost.accounts.{slug}-coach.
  // No plugins.entries reference at all.
  const customerMountPatchedRuntime = (
    sourceShape: Record<string, unknown>,
    customer: { slug: string },
  ) => ({
    ...runtimeWithAjvDefaults(sourceShape),
    agents: {
      list: [{ id: `octogee-${customer.slug}-coach`, model: "anthropic/claude-sonnet-4-6" }],
    },
    bindings: [{ agentId: `octogee-${customer.slug}-coach` }],
    channels: {
      mattermost: {
        accounts: {
          [`${customer.slug}-coach`]: { enabled: true, baseUrl: "http://mm" },
        },
      },
    },
  });

  it("Shape A — source has explicit defaults populated → no leak (sanity baseline)", () => {
    // Source already has the defaults in it, so they're "known" to source.
    // resolvePersistCandidateForWrite shouldn't have anything to do here.
    const sourceEntries = {
      "octogee-router": {
        enabled: true,
        config: {
          enforcement: "observe",
          advisorySlugs: [],
          enforcementOverrides: {},
          faceModelOverrides: {},
          brainModelOverrides: {},
        },
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: runtimeWithAjvDefaults(sourceEntries),
      sourceConfig: {
        gateway: { mode: "local" },
        plugins: {
          enabled: true,
          allow: ["mattermost", "octogee-router", "octogee-mattermost-tools"],
          entries: sourceEntries,
        },
      },
      nextConfig: customerMountPatchedRuntime(sourceEntries, { slug: "alice" }),
    }) as Record<string, any>;

    const persistedRouter = persisted.plugins?.entries?.["octogee-router"];
    expect(persistedRouter?.config).toEqual({
      enforcement: "observe",
      advisorySlugs: [],
      enforcementOverrides: {},
      faceModelOverrides: {},
      brainModelOverrides: {},
    });
  });

  it("Shape B — source has `config: {}`, runtime has AJV defaults → does this leak?", () => {
    // This is what Octogee's TEMPLATE actually produces:
    //   "octogee-router": { "enabled": true, "config": {} }
    // After AJV validation, runtime has defaults filled in.
    // Question: does the persisted source include the runtime defaults?
    const sourceEntries = {
      "octogee-router": {
        enabled: true,
        config: {}, // ← empty, the way the template ships it
      },
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: runtimeWithAjvDefaults(sourceEntries),
      sourceConfig: {
        gateway: { mode: "local" },
        plugins: {
          enabled: true,
          allow: ["mattermost", "octogee-router", "octogee-mattermost-tools"],
          entries: sourceEntries,
        },
      },
      nextConfig: customerMountPatchedRuntime(sourceEntries, { slug: "alice" }),
    }) as Record<string, any>;

    const persistedRouter = persisted.plugins?.entries?.["octogee-router"];

    // If the persisted source carries the AJV defaults, the diff against
    // the previous source (which had empty config) shows them as drift.
    // That drift is what trips the gateway-restart cascade.
    // Use objectContaining so we precisely identify each leaked default.
    expect(persistedRouter?.config).toEqual({});
  });

  it("Shape C — source has NO `config` block, runtime has AJV defaults → does this leak?", () => {
    // Mirrors the upstream-plugin shape (mattermost/anthropic in our
    // template have just `{ enabled: true }`, no `config`).
    const sourceEntries = {
      "octogee-router": {
        enabled: true,
      } as Record<string, unknown>,
    };

    const persisted = resolvePersistCandidateForWrite({
      runtimeConfig: runtimeWithAjvDefaults(sourceEntries),
      sourceConfig: {
        gateway: { mode: "local" },
        plugins: {
          enabled: true,
          allow: ["mattermost", "octogee-router", "octogee-mattermost-tools"],
          entries: sourceEntries,
        },
      },
      nextConfig: customerMountPatchedRuntime(sourceEntries, { slug: "alice" }),
    }) as Record<string, any>;

    const persistedRouter = persisted.plugins?.entries?.["octogee-router"];

    // If Shape C does NOT leak, then dropping `"config": {}` from our
    // template config is the config-only fix.
    // If Shape C DOES leak, the bug is independent of our config shape and
    // we need a fork patch.
    expect(persistedRouter).toEqual({ enabled: true });
  });
});

describe("Octogee plugin-entry default leak — outer writeConfigFile notify gap", () => {
  // Reproduce the runtime snapshot pollution that `prepareSecretsRuntimeSnapshot`
  // creates at boot:
  //
  //   sourceConfig = structuredClone(params.config)   ← validated runtime, has defaults
  //   resolvedConfig = structuredClone(params.config) ← validated runtime, has defaults
  //   setRuntimeConfigSnapshot(resolvedConfig, sourceConfig)
  //
  // i.e. BOTH the runtime snapshot AND the source snapshot end up holding
  // the post-validation runtime config (with AJV-injected plugin defaults
  // baked in). This is the upstream pollution.

  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-octogee-leak-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
    // Register a fake `octogee-router` plugin whose configSchema declares
    // defaults — this is exactly the shape Octogee ships in
    // infra/gateway/extensions/octogee-router/openclaw.plugin.json. We
    // need it registered so AJV's `applyDefaults: true` (now hard-coded
    // in validateConfigObjectWithPlugins post-#61841) fires during
    // re-validation on the second writeConfigFile re-read of disk —
    // matching the production behaviour we're trying to repro.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "octogee-router",
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/octogee-router-fake",
          source: "/tmp/octogee-router-fake/index.ts",
          manifestPath: "/tmp/octogee-router-fake/openclaw.plugin.json",
          configSchema: {
            type: "object",
            additionalProperties: true,
            properties: {
              enforcement: { type: "string", default: "observe" },
              advisorySlugs: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              enforcementOverrides: {
                type: "object",
                additionalProperties: true,
                default: {},
              },
              faceModelOverrides: {
                type: "object",
                additionalProperties: true,
                default: {},
              },
              brainModelOverrides: {
                type: "object",
                additionalProperties: true,
                default: {},
              },
            },
          },
        },
      ],
    } satisfies PluginManifestRegistry);
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup?.();
  });

  afterEach(() => {
    resetConfigRuntimeState();
    mockMaintainConfigBackups.mockReset();
    mockMaintainConfigBackups.mockResolvedValue(undefined);
  });

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return fn(home);
  }

  it("event.sourceConfig matches persisted disk content — no AJV-default leak in reload listener path", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });

      // The on-disk source: octogee-router has `config: {}` (empty), as
      // the Octogee template ships it. NO defaults on disk.
      const onDiskSource = {
        gateway: { mode: "local" },
        plugins: {
          enabled: true,
          allow: ["octogee-router"],
          entries: {
            "octogee-router": { enabled: true, config: {} },
          },
        },
      };
      await fs.writeFile(configPath, `${JSON.stringify(onDiskSource, null, 2)}\n`, "utf-8");

      // Simulate the validated runtime config that AJV produces after
      // applying the plugin's schema defaults. (We don't actually need
      // a registered plugin schema for this repro because we set the
      // snapshots manually — we just need the snapshot pair to mirror
      // what `prepareSecretsRuntimeSnapshot` produces at boot.)
      const validatedRuntime = {
        gateway: { mode: "local" },
        plugins: {
          enabled: true,
          allow: ["octogee-router"],
          entries: {
            "octogee-router": {
              enabled: true,
              config: {
                enforcement: "observe", // ← AJV default
                advisorySlugs: [],
                enforcementOverrides: {},
                faceModelOverrides: {},
                brainModelOverrides: {},
              },
            },
          },
        },
      };

      // ── BUG REPRODUCTION STEP 1 ────────────────────────────────────
      // `prepareSecretsRuntimeSnapshot` at boot does this exact thing:
      // it clones the SAME validated runtime config into BOTH source
      // and runtime snapshots. So `runtimeConfigSourceSnapshot` is
      // polluted with the AJV defaults.
      setRuntimeConfigSnapshot(
        structuredClone(validatedRuntime),
        structuredClone(validatedRuntime), // ← THIS is the pollution
      );

      // Capture what the reloader will receive. The reloader stashes
      // `pendingInProcessConfig.compareConfig = event.sourceConfig` and
      // diffs it against `currentCompareConfig` (which is initialized
      // at boot from the on-disk sourceConfig — NO defaults).
      const observedSourceConfigs: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSourceConfigs.push(event.sourceConfig);
      });

      try {
        // ── BUG REPRODUCTION STEP 2 ──────────────────────────────────
        // A customer-mount config.patch hands the validated.config to
        // writeConfigFile. The patch only adds an agent + a binding —
        // it does NOT touch plugins.* — but `validated.config` already
        // carries the AJV defaults from the validation pass.
        const customerMountCfg = {
          ...structuredClone(validatedRuntime),
          agents: {
            list: [{ id: "octogee-alice-coach", model: "anthropic/claude-sonnet-4-6" }],
          },
        };

        await writeConfigFile(customerMountCfg);

        // ── ASSERTION 1: disk file is CLEAN ───────────────────────────
        // resolvePersistCandidateForWrite strips defaults out by
        // projecting onto the raw source it re-reads from disk.
        const persistedRaw = await fs.readFile(configPath, "utf-8");
        const persisted = JSON.parse(persistedRaw);
        expect(persisted.plugins.entries["octogee-router"].config).toEqual({});

        // ── ASSERTION 2: event.sourceConfig matches the disk content ─
        // After the Octogee fork patch (io.ts:2370 →
        // `sourceConfig: writeResult.persistedConfig`), listeners
        // observe the actual on-disk shape, not the in-memory merge
        // result against the polluted runtimeConfigSourceSnapshot.
        expect(observedSourceConfigs.length).toBeGreaterThan(0);
        const lastObserved = observedSourceConfigs[observedSourceConfigs.length - 1] as Record<
          string,
          any
        >;
        expect(lastObserved.plugins.entries["octogee-router"].config).toEqual({});

        // ── ASSERTION 3: no `plugins.*` leakage to the reloader ───────
        // The reloader uses event.sourceConfig as its diff target for
        // in-process writes. With the fork patch, no AJV defaults
        // surface as "newly added" paths under
        // `plugins.entries.octogee-router.config.*`, so the reload
        // classifier no longer escalates to SIGUSR1 on every mount.
        const diskRouterConfig = persisted.plugins?.entries?.["octogee-router"]?.config ?? {};
        const observedRouterConfig =
          lastObserved.plugins?.entries?.["octogee-router"]?.config ?? {};
        const leakedKeys = Object.keys(observedRouterConfig).filter(
          (k) => !(k in diskRouterConfig),
        );
        expect(leakedKeys).toEqual([]);
      } finally {
        unsubscribe();
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });
});
