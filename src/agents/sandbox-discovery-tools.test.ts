import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createHostWorkspaceDiscoveryOperations,
  createSandboxDiscoveryOperations,
} from "./sandbox-discovery-tools.js";
import {
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  type SandboxFsDiscoveryBridge,
} from "./sandbox/fs-bridge.discovery.js";
import { createFindToolDefinition } from "./sessions/tools/find.js";
import { createGrepToolDefinition } from "./sessions/tools/grep.js";
import { createLsToolDefinition } from "./sessions/tools/ls.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createBridge(
  listDirectory: SandboxFsDiscoveryBridge["listDirectory"],
): SandboxFsDiscoveryBridge {
  return {
    resolvePath: ({ filePath }) => ({ relativePath: filePath, containerPath: filePath }),
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    mkdirp: async () => {},
    remove: async () => {},
    rename: async () => {},
    stat: async () => ({ type: "directory", size: 0, mtimeMs: 0 }),
    listDirectory,
  };
}

function abortableListing() {
  let observedSignal: AbortSignal | undefined;
  const listDirectory = vi.fn(
    ({ signal }: { signal?: AbortSignal }) =>
      new Promise<[]>((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  return { listDirectory, observedSignal: () => observedSignal };
}

describe("sandbox discovery operation cancellation", () => {
  it("stops bridge traversal when find reaches its deadline", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createFindToolDefinition("/workspace", {
      operations: operations.find,
      timeoutMs: 5,
    });

    await expect(
      tool.execute("find", { pattern: "**/*" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Find timed out after 5ms");
    expect(listing.observedSignal()?.aborted).toBe(true);
  });

  it("stops bridge traversal when grep reaches its deadline", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createGrepToolDefinition("/workspace", {
      operations: operations.grep,
      timeoutMs: 5,
    });

    await expect(
      tool.execute("grep", { pattern: "value" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Grep timed out after 5ms");
    expect(listing.observedSignal()?.aborted).toBe(true);
  });

  it("passes caller cancellation through ls to the bridge", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createLsToolDefinition("/workspace", { operations: operations.ls });
    const controller = new AbortController();
    const result = tool.execute("ls", {}, controller.signal, undefined, {} as never);
    await vi.waitFor(() => expect(listing.listDirectory).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    expect(listing.observedSignal()).toBe(controller.signal);
    expect(listing.observedSignal()?.aborted).toBe(true);
  });
});

describe("sandbox ls entry classification", () => {
  it("keeps entry types attached to concurrent listing results", async () => {
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolveSecondStarted) => {
      markSecondStarted = resolveSecondStarted;
    });
    const listDirectory = vi.fn(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith("first")) {
        await secondStarted;
        return [{ name: "outward-link", type: "other" as const }];
      }
      markSecondStarted?.();
      return [{ name: "nested", type: "directory" as const }];
    });
    const operations = createSandboxDiscoveryOperations(createBridge(listDirectory));

    const [first, second] = await Promise.all([
      operations.ls.readdir("/workspace/first"),
      operations.ls.readdir("/workspace/second"),
    ]);

    expect(first).toEqual([{ name: "outward-link", isDirectory: false }]);
    expect(second).toEqual([{ name: "nested", isDirectory: true }]);
  });
});

describe("host workspace discovery bounds", () => {
  it.runIf(process.platform === "linux")(
    "rejects a real directory over the discovery entry limit",
    async () => {
      const stateDir = tempDirs.make("openclaw-host-discovery-");
      try {
        const names = Array.from(
          { length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 },
          (_, index) => `entry-${index}`,
        );
        for (let start = 0; start < names.length; start += 500) {
          await Promise.all(
            names
              .slice(start, start + 500)
              .map((name) => fs.writeFile(path.join(stateDir, name), "")),
          );
        }
        const operations = createHostWorkspaceDiscoveryOperations(stateDir);

        await expect(operations.ls.readdir(stateDir)).rejects.toThrow("entry limit");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
