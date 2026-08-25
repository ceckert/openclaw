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
        entry: { sessionId: string };
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
    (_sessionKey: string, _opts?: unknown): { entry?: { sessionId?: string } } => ({
      entry: { sessionId: "durable-session-id" },
    }),
  ),
  executeSessionPatch: vi.fn<(params: SessionPatchParams) => Promise<SessionPatchResult>>(
    async () => patchSuccess("materialized-session-id"),
  ),
}));

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
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy: (agentId?: string) => policy.resolve(agentId),
    isTerminalEnabled: () => policy.isEnabled(),
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
  return { opts, terminalSessions, respond, isConnectionActive };
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
    sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: undefined });
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
    sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: undefined });
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

  it("does not materialize a durable owner after the terminal connection closes", async () => {
    sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: undefined });
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

  it("prevents durable owner materialization from committing after the open deadline", async () => {
    vi.useFakeTimers();
    try {
      sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: undefined });
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
