import { describe, expect, it } from "vitest";
import {
  SANDBOX_FS_DIRECTORY_MAX_BYTES,
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  parseSandboxDirectoryEntries,
} from "./fs-bridge.discovery.js";

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
