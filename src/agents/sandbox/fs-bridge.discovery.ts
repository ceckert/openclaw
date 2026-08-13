import type { SandboxFsBridge, SandboxFsDirectoryEntry } from "./fs-bridge.types.js";

export type { SandboxFsDirectoryEntry } from "./fs-bridge.types.js";

export const SANDBOX_FS_DIRECTORY_MAX_ENTRIES = 10_000;
export const SANDBOX_FS_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;

export type SandboxFsDiscoveryBridge = SandboxFsBridge & {
  listDirectory: NonNullable<SandboxFsBridge["listDirectory"]>;
};

export function supportsSandboxFsDiscovery(
  bridge: SandboxFsBridge,
): bridge is SandboxFsDiscoveryBridge {
  return typeof bridge.listDirectory === "function";
}

export function assertSandboxDirectoryEntriesWithinBounds(
  entries: readonly SandboxFsDirectoryEntry[],
): void {
  if (entries.length > SANDBOX_FS_DIRECTORY_MAX_ENTRIES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_ENTRIES} entry limit.`,
    );
  }
  const names = new Set<string>();
  let serializedBytes = 2;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      names.has(entry.name) ||
      (entry.type !== "file" && entry.type !== "directory" && entry.type !== "other")
    ) {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    names.add(entry.name);
    serializedBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + (index > 0 ? 1 : 0);
    if (serializedBytes > SANDBOX_FS_DIRECTORY_MAX_BYTES) {
      throw new Error(
        `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_BYTES} byte limit.`,
      );
    }
  }
}

export function parseSandboxDirectoryEntries(value: Buffer): SandboxFsDirectoryEntry[] {
  if (value.byteLength > SANDBOX_FS_DIRECTORY_MAX_BYTES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_BYTES} byte limit.`,
    );
  }
  const parsed: unknown = JSON.parse(value.toString("utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Sandbox directory listing returned an invalid result.");
  }
  if (parsed.length > SANDBOX_FS_DIRECTORY_MAX_ENTRIES) {
    throw new Error(
      `Sandbox directory listing exceeds the ${SANDBOX_FS_DIRECTORY_MAX_ENTRIES} entry limit.`,
    );
  }
  const entries = parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    const name = Reflect.get(entry, "name");
    const type = Reflect.get(entry, "type");
    if (
      typeof name !== "string" ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      (type !== "file" && type !== "directory" && type !== "other")
    ) {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    return { name, type };
  });
  assertSandboxDirectoryEntriesWithinBounds(entries);
  return entries;
}
