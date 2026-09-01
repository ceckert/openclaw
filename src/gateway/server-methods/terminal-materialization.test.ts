import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { openTerminalSession, TERMINAL_OPEN_DEADLINE_MS } from "./terminal.js";

type SessionPatchResult =
  | { ok: false; error: ErrorShape }
  | {
      ok: true;
      result: {
        ok: true;
        path: string;
        key: string;
        entry: {
          sessionId: string;
          pendingWorktree?: { workspace: string; titleSource: string };
        };
      };
    };

type SessionPatchParams = {
  client?: unknown;
  context?: unknown;
  patch: { agentId?: string; key: string };
  sessionMutationAuthorization?: {
    assertCurrent: () => void;
    assertTargetCurrent: (target: { sessionKey: string; agentId?: string }) => void;
  };
};

type TestSessionEntry = {
  sessionId?: string;
  archivedAt?: number;
  pendingWorktree?: { workspace: string; titleSource: string };
};

function patchSuccess(sessionId: string): Extract<SessionPatchResult, { ok: true }> {
  return {
    ok: true,
    result: {
      ok: true,
      path: "/sessions.sqlite",
      key: "agent:main:missing",
      entry: { sessionId },
    },
  };
}

const sessionMocks = vi.hoisted(() => ({
  loadGatewaySessionEntryReadOnly: vi.fn(
    (_sessionKey: string, _opts?: unknown): { entry?: TestSessionEntry } => ({
      entry: { sessionId: "durable-session-id" },
    }),
  ),
  executeSessionPatch: vi.fn<(params: SessionPatchParams) => Promise<SessionPatchResult>>(
    async () => patchSuccess("materialized-session-id"),
  ),
}));

function mockFreshSessionAfterPatch(
  entry: TestSessionEntry = { sessionId: "materialized-session-id" },
): void {
  sessionMocks.loadGatewaySessionEntryReadOnly
    .mockReturnValueOnce({ entry: undefined })
    .mockReturnValue({ entry });
}

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnly: sessionMocks.loadGatewaySessionEntryReadOnly,
}));

vi.mock("./sessions-patch-engine.js", () => ({
  executeSessionPatch: sessionMocks.executeSessionPatch,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeOpts() {
  const terminalSessions = {
    open: vi.fn(async () => ({
      ok: true as const,
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    })),
  };
  const runtimeConfig = { gateway: { terminal: { enabled: true } } } as OpenClawConfig;
  const policy = createTerminalLaunchPolicy(runtimeConfig);
  const respond = vi.fn();
  const isConnectionActive = vi.fn(() => true);
  const isTerminalEnabled = vi.fn(() => policy.isEnabled());
  const resolveTerminalLaunchPolicy = vi.fn((agentId?: string) => policy.resolve(agentId));
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy,
    isTerminalEnabled,
    terminalSessions,
    nodeRegistry: { get: () => undefined, invoke: vi.fn() },
    isConnectionActive,
    logGateway: { info: vi.fn() },
  } as unknown as Parameters<typeof openTerminalSession>[0]["context"];
  const opts = {
    params: {},
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<typeof openTerminalSession>[0];
  return {
    opts,
    terminalSessions,
    respond,
    isConnectionActive,
    isTerminalEnabled,
    resolveTerminalLaunchPolicy,
  };
}

afterEach(() => {
  sessionMocks.loadGatewaySessionEntryReadOnly.mockReset().mockReturnValue({
    entry: { sessionId: "durable-session-id" },
  });
  sessionMocks.executeSessionPatch
    .mockReset()
    .mockResolvedValue(patchSuccess("materialized-session-id"));
});

describe("terminal durable owner materialization", () => {
  it("keeps an existing durable terminal open read-only", async () => {
    const { opts, terminalSessions } = makeOpts();

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:durable",
      cols: 80,
      rows: 24,
    });

    expect(terminalSessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: {
          kind: "agent",
          agentSessionKey: "agent:main:durable",
          agentSessionId: "durable-session-id",
          agentId: "main",
        },
      }),
    );
    expect(sessionMocks.executeSessionPatch).not.toHaveBeenCalled();
  });

  it("materializes a durable owner before opening a terminal from a fresh chat", async () => {
    mockFreshSessionAfterPatch();
    const { opts, terminalSessions, respond } = makeOpts();

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });

    expect(terminalSessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: {
          kind: "agent",
          agentSessionKey: "agent:main:missing",
          agentSessionId: "materialized-session-id",
          agentId: "main",
        },
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main", sessionId: "terminal-1" }),
    );
    expect(sessionMocks.executeSessionPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        client: opts.client,
        context: opts.context,
        patch: { agentId: "main", key: "agent:main:missing" },
      }),
    );
  });

  it("does not open a terminal when durable owner materialization fails", async () => {
    mockFreshSessionAfterPatch();
    const error = { code: ErrorCodes.UNAVAILABLE, message: "session materialization failed" };
    sessionMocks.executeSessionPatch.mockResolvedValue({ ok: false, error });
    const { opts, terminalSessions, respond } = makeOpts();

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });

    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, error);
  });

  it("does not open a terminal while the materialized session workspace is pending", async () => {
    mockFreshSessionAfterPatch({
      sessionId: "materialized-session-id",
      pendingWorktree: { workspace: "/tmp/project", titleSource: "Prepare workspace" },
    });
    sessionMocks.executeSessionPatch.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        path: "/sessions.sqlite",
        key: "agent:main:missing",
        entry: {
          sessionId: "materialized-session-id",
          pendingWorktree: { workspace: "/tmp/project", titleSource: "Prepare workspace" },
        },
      },
    });
    const { opts, terminalSessions, respond } = makeOpts();

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });

    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          'Session "agent:main:missing" workspace is not ready. Wait for setup to finish or retry in chat.',
      }),
    );
  });

  it.each([
    {
      state: "deleted",
      entry: undefined,
      message: 'Session "agent:main:missing" was deleted while starting work. Retry.',
    },
    {
      state: "replaced",
      entry: { sessionId: "replacement-session-id" },
      message: 'Session "agent:main:missing" changed while starting work. Retry.',
    },
    {
      state: "archived",
      entry: { sessionId: "materialized-session-id", archivedAt: 1 },
      message: 'Session "agent:main:missing" is archived. Restore it before starting new work.',
    },
  ])(
    "does not open when the materialized owner is $state before patch returns",
    async (testCase) => {
      let storedEntry: TestSessionEntry | undefined;
      sessionMocks.loadGatewaySessionEntryReadOnly.mockImplementation(() => ({
        entry: storedEntry,
      }));
      const patchCommitted = deferred<void>();
      const returnPatch = deferred<void>();
      sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
        params.sessionMutationAuthorization?.assertCurrent();
        storedEntry = { sessionId: "materialized-session-id" };
        patchCommitted.resolve();
        await returnPatch.promise;
        return patchSuccess("materialized-session-id");
      });
      const { opts, terminalSessions, respond } = makeOpts();

      const opening = openTerminalSession(opts, {
        agentId: "main",
        sessionKey: "agent:main:missing",
        cols: 80,
        rows: 24,
      });
      await patchCommitted.promise;
      storedEntry = testCase.entry;
      returnPatch.resolve();
      await opening;

      expect(terminalSessions.open).not.toHaveBeenCalled();
      expect(sessionMocks.loadGatewaySessionEntryReadOnly).toHaveBeenNthCalledWith(
        2,
        "agent:main:missing",
        { agentId: "main", clone: false },
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST, message: testCase.message }),
      );
    },
  );

  it("does not materialize a durable owner after the terminal connection closes", async () => {
    mockFreshSessionAfterPatch();
    const beforeCommit = deferred<void>();
    let materializationCommitted = false;
    sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
      await beforeCommit.promise;
      try {
        params.sessionMutationAuthorization?.assertCurrent();
        materializationCommitted = true;
        return patchSuccess("materialized-session-id");
      } catch (error) {
        return { ok: false, error: (error as { error: ErrorShape }).error };
      }
    });
    const { opts, terminalSessions, respond, isConnectionActive } = makeOpts();

    const opening = openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => expect(sessionMocks.executeSessionPatch).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    beforeCommit.resolve();
    await opening;

    expect(materializationCommitted).toBe(false);
    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("does not open after the terminal connection closes once materialization commits", async () => {
    mockFreshSessionAfterPatch();
    const { opts, terminalSessions, respond, isConnectionActive } = makeOpts();
    sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
      params.sessionMutationAuthorization?.assertCurrent();
      isConnectionActive.mockReturnValue(false);
      return patchSuccess("materialized-session-id");
    });

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });

    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("does not materialize or open after terminal policy is disabled", async () => {
    mockFreshSessionAfterPatch();
    const beforeCommit = deferred<void>();
    let materializationCommitted = false;
    sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
      await beforeCommit.promise;
      try {
        params.sessionMutationAuthorization?.assertCurrent();
        materializationCommitted = true;
        return patchSuccess("materialized-session-id");
      } catch (error) {
        return { ok: false, error: (error as { error: ErrorShape }).error };
      }
    });
    const { opts, terminalSessions, respond, isTerminalEnabled } = makeOpts();

    const opening = openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => expect(sessionMocks.executeSessionPatch).toHaveBeenCalledOnce());
    isTerminalEnabled.mockReturnValue(false);
    beforeCommit.resolve();
    await opening;

    expect(materializationCommitted).toBe(false);
    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal is disabled" }),
    );
  });

  it("does not open after the agent becomes sandboxed once materialization commits", async () => {
    mockFreshSessionAfterPatch();
    let materializationCommitted = false;
    const { opts, terminalSessions, respond, resolveTerminalLaunchPolicy } = makeOpts();
    sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
      params.sessionMutationAuthorization?.assertCurrent();
      materializationCommitted = true;
      resolveTerminalLaunchPolicy.mockReturnValue({
        ok: false,
        block: { kind: "sandboxed", agentId: "main", mode: "all" },
      });
      return patchSuccess("materialized-session-id");
    });

    await openTerminalSession(opts, {
      agentId: "main",
      sessionKey: "agent:main:missing",
      cols: 80,
      rows: 24,
    });

    expect(materializationCommitted).toBe(true);
    expect(terminalSessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("runs in a sandbox") }),
    );
  });

  it("prevents durable owner materialization from committing after the open deadline", async () => {
    vi.useFakeTimers();
    try {
      mockFreshSessionAfterPatch();
      const materialized = deferred<Extract<SessionPatchResult, { ok: true }>>();
      const lateAttempt = deferred<void>();
      let materializationCommitted = false;
      sessionMocks.executeSessionPatch.mockImplementationOnce(async (params) => {
        const result = await materialized.promise;
        try {
          params.sessionMutationAuthorization?.assertCurrent();
          materializationCommitted = true;
          return result;
        } finally {
          lateAttempt.resolve();
        }
      });
      const { opts, terminalSessions, respond } = makeOpts();

      const opening = openTerminalSession(opts, {
        agentId: "main",
        sessionKey: "agent:main:missing",
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(() => expect(sessionMocks.executeSessionPatch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
      await opening;

      expect(terminalSessions.open).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
      materialized.resolve(patchSuccess("late-session-id"));
      await lateAttempt.promise;
      expect(materializationCommitted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
