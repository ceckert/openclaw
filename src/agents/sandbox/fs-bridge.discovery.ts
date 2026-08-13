import type { SandboxFsBridge } from "./fs-bridge.types.js";

export type SandboxFsDirectoryEntry = {
  name: string;
  type: "file" | "directory" | "other";
};

export type SandboxFsDiscoveryBridge = {
  listDirectory(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsDirectoryEntry[]>;
};

export function supportsSandboxFsDiscovery(
  bridge: SandboxFsBridge,
): bridge is SandboxFsBridge & SandboxFsDiscoveryBridge {
  return "listDirectory" in bridge && typeof bridge.listDirectory === "function";
}

export function parseSandboxDirectoryEntries(value: Buffer): SandboxFsDirectoryEntry[] {
  const parsed: unknown = JSON.parse(value.toString("utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Sandbox directory listing returned an invalid result.");
  }
  const names = new Set<string>();
  return parsed.map((entry) => {
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
      names.has(name) ||
      (type !== "file" && type !== "directory" && type !== "other")
    ) {
      throw new Error("Sandbox directory listing returned an invalid entry.");
    }
    names.add(name);
    return { name, type };
  });
}
