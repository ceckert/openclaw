/**
 * Public SDK subpath for sandbox backends, SSH execution, and temp workspace helpers.
 */
export type {
  CreateSandboxBackendParams,
  RemoteShellSandboxHandle,
  RunSshSandboxCommandParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxFsBridge,
  SandboxFsDirectoryEntry,
  SandboxFsStat,
  SandboxBackendHandle,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
  SandboxBackendWorkdirValidator,
  SandboxContext,
  SandboxResolvedPath,
  SandboxSshConfig,
  SshSandboxSession,
  SshSandboxSettings,
} from "../agents/sandbox.js";
export type { OpenClawConfig } from "../config/config.js";

export {
  assertSandboxDirectoryEntriesWithinBounds,
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildRemoteCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  createWritableRenameTargetResolver,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  isToolAllowed,
  prepareSshSandboxExec,
  registerSandboxBackend,
  requireSandboxBackendFactory,
  SANDBOX_FS_DIRECTORY_MAX_BYTES,
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  resolveSandboxRuntimeStatus,
  resolveWritableRenameTargets,
  resolveWritableRenameTargetsForBridge,
  runSshSandboxCommand,
  sanitizeEnvVars,
  shellEscape,
  uploadDirectoryToSshTarget,
} from "../agents/sandbox.js";

export {
  runPluginCommandWithTimeout,
  type PluginCommandRunOptions,
  type PluginCommandRunResult,
} from "./run-command.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export {
  tempWorkspace,
  tempWorkspaceSync,
  type TempWorkspace,
  type TempWorkspaceOptions,
  type TempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../infra/private-temp-workspace.js";
