/** Public filesystem contract for sandbox backend discovery. */
export type {
  SandboxFsBridge,
  SandboxFsDirectoryEntry,
  SandboxFsStat,
  SandboxResolvedPath,
} from "../agents/sandbox/fs-bridge.types.js";
export type { SandboxFsDiscoveryBridge } from "../agents/sandbox/fs-bridge.discovery.js";
export {
  assertSandboxDirectoryEntriesWithinBounds,
  SANDBOX_FS_DIRECTORY_MAX_BYTES,
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  supportsSandboxFsDiscovery,
} from "../agents/sandbox/fs-bridge.discovery.js";
