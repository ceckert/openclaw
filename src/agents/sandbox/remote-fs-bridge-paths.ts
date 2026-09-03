/** Pure mount and path helpers for the remote sandbox filesystem bridge. */
import path from "node:path";
import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
import { normalizeContainerPathCore } from "./path-utils.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./workspace-mounts.js";

export type RemoteMountSource = "workspace" | "agent" | "protectedSkill";

export type RemoteMountInfo = {
  localRoot: string;
  containerRoot: string;
  writable: boolean;
  source: RemoteMountSource;
};

export function buildRemoteSandboxMounts(params: {
  sandbox: SandboxFsBridgeContext;
  runtime: { remoteWorkspaceDir: string; remoteAgentWorkspaceDir: string };
}): RemoteMountInfo[] {
  const workspaceRoot = path.resolve(params.sandbox.workspaceDir);
  const agentRoot = path.resolve(params.sandbox.agentWorkspaceDir);
  const workspaceContainerRoot = normalizeContainerPath(params.runtime.remoteWorkspaceDir);
  const agentContainerRoot = normalizeContainerPath(params.runtime.remoteAgentWorkspaceDir);
  const hasAgentMount = params.sandbox.workspaceAccess !== "none" && agentRoot !== workspaceRoot;
  const mounts: RemoteMountInfo[] = [
    {
      localRoot: workspaceRoot,
      containerRoot: workspaceContainerRoot,
      writable: params.sandbox.workspaceAccess !== "ro",
      source: "workspace",
    },
  ];
  if (hasAgentMount) {
    mounts.push({
      localRoot: agentRoot,
      containerRoot: agentContainerRoot,
      writable: params.sandbox.workspaceAccess === "rw",
      source: "agent",
    });
  }
  for (const workdir of [workspaceContainerRoot, ...(hasAgentMount ? [agentContainerRoot] : [])]) {
    mounts.push(
      ...resolveReadOnlyWorkspaceSkillMounts({ ...params.sandbox, workdir }).map(
        (mount): RemoteMountInfo => ({
          localRoot: mount.hostPath,
          containerRoot: mount.containerPath,
          writable: false,
          source: "protectedSkill",
        }),
      ),
    );
  }
  for (const resource of params.sandbox.readOnlyResourceMounts ?? []) {
    mounts.push({
      localRoot: resource.hostPath,
      containerRoot: resource.containerPath,
      writable: false,
      source: "protectedSkill",
    });
  }
  return mounts;
}

export function compareRemoteMountsByContainerPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return b.containerRoot.length - a.containerRoot.length || mountPriority(b) - mountPriority(a);
}

export function compareRemoteMountsByLocalPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return b.localRoot.length - a.localRoot.length || mountPriority(b) - mountPriority(a);
}

export function buildRemoteProtectedSkillRoots(params: {
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): string[] {
  const roots = [
    path.posix.join(params.workspaceContainerRoot, "skills"),
    path.posix.join(params.workspaceContainerRoot, ".agents", "skills"),
    path.posix.join(params.workspaceContainerRoot, ".openclaw", "sandbox-skills", "skills"),
  ];
  if (params.includeAgentMount) {
    roots.push(
      path.posix.join(params.agentContainerRoot, "skills"),
      path.posix.join(params.agentContainerRoot, ".agents", "skills"),
      path.posix.join(params.agentContainerRoot, ".openclaw", "sandbox-skills", "skills"),
    );
  }
  return roots;
}

function mountPriority(mount: RemoteMountInfo): number {
  if (mount.source === "protectedSkill") {
    return 2;
  }
  if (mount.source === "agent") {
    return 1;
  }
  return 0;
}

export function normalizeContainerPath(value: string): string {
  const normalized = normalizeContainerPathCore(value.trim() || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
