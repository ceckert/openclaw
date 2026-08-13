import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { root as fsRoot } from "../../infra/fs-safe.js";
import {
  SANDBOX_FS_DIRECTORY_MAX_BYTES,
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  listSandboxDirectoryWithinBounds,
  parseSandboxDirectoryEntries,
  type SandboxDirectoryListingSource,
} from "./fs-bridge.discovery.js";

type TypedSourceEntry = { name: string; isDirectory: boolean; isFile: boolean };

function listingSource(params: {
  names: string[];
  typed?: TypedSourceEntry[];
  onNames?: () => void;
  onTyped?: () => void;
}): { source: SandboxDirectoryListingSource; namesCalls: () => number; typedCalls: () => number } {
  const list = vi.fn((_relativePath: string, options?: { withFileTypes?: boolean }) => {
    if (options?.withFileTypes) {
      params.onTyped?.();
      return Promise.resolve(
        params.typed ?? params.names.map((name) => ({ name, isDirectory: false, isFile: true })),
      );
    }
    params.onNames?.();
    return Promise.resolve(params.names);
  });
  return {
    source: { list } as unknown as SandboxDirectoryListingSource,
    namesCalls: () => list.mock.calls.filter(([, options]) => !options?.withFileTypes).length,
    typedCalls: () =>
      list.mock.calls.filter(([, options]) => options?.withFileTypes === true).length,
  };
}

describe("sandbox directory entry parsing", () => {
  it("accepts bounded entry names and types", () => {
    expect(
      parseSandboxDirectoryEntries(
        Buffer.from(
          JSON.stringify([
            { name: "src", type: "directory" },
            { name: "README.md", type: "file" },
            { name: "link", type: "other" },
          ]),
        ),
      ),
    ).toEqual([
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
      { name: "link", type: "other" },
    ]);
  });

  it.each([".", "..", "../secret", "nested/file", "nested\\file", "bad\0name"])(
    "rejects unsafe entry name %j",
    (name) => {
      expect(() =>
        parseSandboxDirectoryEntries(Buffer.from(JSON.stringify([{ name, type: "file" }]))),
      ).toThrow("invalid entry");
    },
  );

  it("rejects duplicate entry names", () => {
    expect(() =>
      parseSandboxDirectoryEntries(
        Buffer.from(
          JSON.stringify([
            { name: "same", type: "file" },
            { name: "same", type: "directory" },
          ]),
        ),
      ),
    ).toThrow("invalid entry");
  });

  it("rejects listings over the entry boundary", () => {
    const entries = Array.from({ length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `entry-${index}`,
      type: "file",
    }));

    expect(() => parseSandboxDirectoryEntries(Buffer.from(JSON.stringify(entries)))).toThrow(
      "entry limit",
    );
  });

  it("rejects listings over the serialized byte boundary", () => {
    expect(() =>
      parseSandboxDirectoryEntries(Buffer.alloc(SANDBOX_FS_DIRECTORY_MAX_BYTES + 1, 0x20)),
    ).toThrow("byte limit");
  });
});

describe("bounded sandbox directory listing", () => {
  it("rejects an over-limit directory before materializing typed entries", async () => {
    const names = Array.from(
      { length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 },
      (_, index) => `entry-${index}`,
    );
    const { source, typedCalls } = listingSource({ names });

    await expect(listSandboxDirectoryWithinBounds({ source, relativePath: "" })).rejects.toThrow(
      "entry limit",
    );
    expect(typedCalls()).toBe(0);
  });

  it("does not start scanning for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { source, namesCalls, typedCalls } = listingSource({ names: ["a"] });

    await expect(
      listSandboxDirectoryWithinBounds({ source, relativePath: "", signal: controller.signal }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(namesCalls()).toBe(0);
    expect(typedCalls()).toBe(0);
  });

  it("stops between the name scan and typed materialization on cancellation", async () => {
    const controller = new AbortController();
    const { source, typedCalls } = listingSource({
      names: ["a", "b"],
      onNames: () => controller.abort(),
    });

    await expect(
      listSandboxDirectoryWithinBounds({ source, relativePath: "", signal: controller.signal }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(typedCalls()).toBe(0);
  });

  it("rejects typed listings that grow past the entry limit", async () => {
    const typed = Array.from({ length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 }, (_, index) => ({
      name: `entry-${index}`,
      isDirectory: false,
      isFile: true,
    }));
    const { source } = listingSource({ names: ["stale"], typed });

    await expect(listSandboxDirectoryWithinBounds({ source, relativePath: "" })).rejects.toThrow(
      "entry limit",
    );
  });

  it("enforces the serialized byte limit", async () => {
    const name = "n".repeat(4096);
    const names = Array.from({ length: 2048 }, (_, index) => `${name}-${index}`);
    const { source } = listingSource({ names });

    await expect(listSandboxDirectoryWithinBounds({ source, relativePath: "" })).rejects.toThrow(
      "byte limit",
    );
  });

  it("rejects invalid entry names from the backend", async () => {
    const { source } = listingSource({ names: ["nested/file"] });

    await expect(listSandboxDirectoryWithinBounds({ source, relativePath: "" })).rejects.toThrow(
      "invalid entry",
    );
  });

  it("maps backend entries to bounded discovery types", async () => {
    const { source } = listingSource({
      names: ["docs", "readme.md", "link"],
      typed: [
        { name: "docs", isDirectory: true, isFile: false },
        { name: "readme.md", isDirectory: false, isFile: true },
        { name: "link", isDirectory: false, isFile: false },
      ],
    });

    await expect(listSandboxDirectoryWithinBounds({ source, relativePath: "" })).resolves.toEqual([
      { name: "docs", type: "directory" },
      { name: "readme.md", type: "file" },
      { name: "link", type: "other" },
    ]);
  });

  it("lists a real directory through a safe filesystem root", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-discovery-"));
    try {
      await fs.mkdir(path.join(stateDir, "docs"));
      await fs.writeFile(path.join(stateDir, "readme.md"), "hello");
      await fs.symlink(path.join(stateDir, "readme.md"), path.join(stateDir, "link"));

      await expect(
        listSandboxDirectoryWithinBounds({
          source: await fsRoot(stateDir),
          relativePath: "",
        }),
      ).resolves.toEqual([
        { name: "docs", type: "directory" },
        { name: "link", type: "other" },
        { name: "readme.md", type: "file" },
      ]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
