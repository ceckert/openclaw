import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectNpmPackInventory } from "../../scripts/lib/npm-pack-inventory.mts";
import { createRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("ships the Gateway's workspace launchers while sealing the portable worker graph", () => {
  const packageRoot = tempDirs.make("workspace-worker-package-");
  const runtimeProcessEntrypoints = createRuntimeProcessEntrypoints(import.meta.url);
  const { files } = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "workspace-worker-fixture", version: "1.0.0", files }),
  );
  const launchers = [
    runtimeProcessEntrypoints.workspaceMemory,
    runtimeProcessEntrypoints.workspaceSkills,
  ].map((entry) => `dist/${entry.distWorkerPath}`);
  for (const file of [
    ...launchers,
    "dist/worker/worker.mjs",
    "dist/worker-artifacts/sealed.tar.gz",
  ]) {
    const target = join(packageRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  const inventory = collectNpmPackInventory(packageRoot, { timeoutMs: 10_000 });
  expect(inventory.files).toEqual(expect.arrayContaining(launchers));
  expect(inventory.files).toContain("dist/worker-artifacts/sealed.tar.gz");
  expect(inventory.files).not.toContain("dist/worker/worker.mjs");
});
