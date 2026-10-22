import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const mainThread = vi.hoisted(() => ({ refusesStateReads: false }));

// A PostgreSQL Gateway main thread refuses synchronous state reads; worker reads still succeed.
vi.mock("../state/config-machine-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/config-machine-state.js")>();
  return {
    ...actual,
    readConfigMachineState: (key: string, ...rest: unknown[]) => {
      if (mainThread.refusesStateReads && key === "plugins.bundledDiscovery") {
        throw new Error(
          "Cannot open PostgreSQL connection: PostgreSQL connections must run in a worker",
        );
      }
      return (actual.readConfigMachineState as (...args: unknown[]) => unknown)(key, ...rest);
    },
  };
});

it("reports an invalid startup config instead of a synchronous plugin discovery state read", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw/openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local" },
        agents: {
          entries: {
            main: { workspace: path.join(home, "workspace") },
            helper: { workspace: path.join(home, "workspace-helper") },
          },
        },
      }),
    );
    // A starting Gateway has not derived the discovery mode yet.
    clearBundledDiscoveryModeMemo();
    mainThread.refusesStateReads = true;
    try {
      const { snapshot } = await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(expect.objectContaining({ path: "agents.ownership" }));
    } finally {
      mainThread.refusesStateReads = false;
    }
  });
});
