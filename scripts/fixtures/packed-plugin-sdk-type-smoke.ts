// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk/core"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/plugin-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
  typeof import("openclaw/plugin-sdk/sandbox-fs"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;

void resolvedModules;

async function discoverSandboxDirectory(
  bridge: import("openclaw/plugin-sdk/sandbox-fs").SandboxFsBridge,
): Promise<import("openclaw/plugin-sdk/sandbox-fs").SandboxFsDirectoryEntry[]> {
  if (!bridge.listDirectory) {
    return [];
  }
  return await bridge.listDirectory({ filePath: "." });
}

void discoverSandboxDirectory;
