import { describe, expect, it, vi } from "vitest";
import { createSandboxDiscoveryOperations } from "./sandbox-discovery-tools.js";
import type { SandboxFsDiscoveryBridge } from "./sandbox/fs-bridge.discovery.js";
import { createFindToolDefinition } from "./sessions/tools/find.js";
import { createGrepToolDefinition } from "./sessions/tools/grep.js";
import { createLsToolDefinition } from "./sessions/tools/ls.js";

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
