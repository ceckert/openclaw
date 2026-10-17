import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "../desktop/node-source-context.js";
import type { NodeDesktopService } from "../desktop/node-source.js";

export type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

export type TestNodeSession = {
  nodeId: string;
  connId?: string;
  pairingGeneration?: string;
  commands: string[];
  declaredCommands?: string[];
  platform?: string;
  client?: { invalidated?: boolean };
};

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

export function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as RespondCall;
}

export function mockArg(source: MockCallSource, callIndex: number, argIndex: number) {
  return mockCall(source, callIndex)[argIndex];
}

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeId: "ios-node-1",
    command: "camera.capture",
    params: { quality: "high" },
    timeoutMs: 5000,
    idempotencyKey: "idem-node-invoke",
    ...overrides,
  };
}

export function createNodeInvokeTestHarness({
  getRuntimeConfig,
  nodeHandlers,
}: {
  getRuntimeConfig: () => unknown;
  nodeHandlers: (typeof import("./nodes.js"))["nodeHandlers"];
}) {
  async function invokeNode(params: {
    nodeRegistry: {
      get: (nodeId: string) => TestNodeSession | undefined;
      getForPairingGeneration?: (
        nodeId: string,
        pairingGeneration: string,
      ) => TestNodeSession | undefined;
      invoke: (payload: {
        nodeId: string;
        command: string;
        params?: unknown;
        timeoutMs?: number;
        signal?: AbortSignal;
        idempotencyKey?: string;
        expectedPairingGeneration?: string;
      }) => Promise<{
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: { code?: string; message?: string } | null;
      }>;
    };
    client?: unknown;
    signal?: AbortSignal;
    requestParams?: Partial<Record<string, unknown>>;
    validateAgentRuntimeApprovalAuthority?: () => boolean;
    desktopService?: Pick<NodeDesktopService, "beginComputerRequest">;
    execApprovalManager?: {
      projectDecisionIfActive: (id: string, decision: string) => string | null;
      retainForHandoff?: (id: string) => (() => void) | null;
    };
  }) {
    const respond = vi.fn();
    const logGateway = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const nodeRegistry = {
      ...params.nodeRegistry,
      getForPairingGeneration:
        params.nodeRegistry.getForPairingGeneration ??
        ((nodeId: string, _pairingGeneration: string) => params.nodeRegistry.get(nodeId)),
    };
    const execApprovalManager = params.execApprovalManager
      ? {
          retainForHandoff: () => () => {},
          ...params.execApprovalManager,
        }
      : undefined;
    await expectDefined(
      nodeHandlers["node.invoke"],
      'nodeHandlers["node.invoke"] test invariant',
    )({
      params: makeNodeInvokeParams(params.requestParams),
      respond: respond as never,
      context: {
        nodeRegistry,
        [NODE_DESKTOP_SERVICE_CONTEXT]: params.desktopService,
        execApprovalManager,
        logGateway,
        getRuntimeConfig,
        validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
      } as never,
      client: (params.client ?? null) as never,
      signal: params.signal,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });
    return respond;
  }

  return invokeNode;
}

export function createOperatorClient(params?: {
  scopes?: string[];
  pluginRuntimeOwnerId?: string;
}) {
  return {
    connect: {
      role: "operator" as const,
      scopes: params?.scopes ?? ["operator.write"],
      client: {
        id: "operator-test",
        mode: "backend" as const,
        name: "operator-test",
        platform: "node",
        version: "test",
      },
    },
    internal: params?.pluginRuntimeOwnerId
      ? { pluginRuntimeOwnerId: params.pluginRuntimeOwnerId }
      : {},
  };
}

export function registerNodeInvokeAdmissionTests({
  mocks,
  invokeNode,
}: {
  mocks: {
    getRuntimeConfig: Pick<Mock<() => unknown>, "mockReturnValue">;
    resolveNodeCommandAllowlist: { mockReturnValue(value: Set<string>): unknown };
    sanitizeNodeInvokeParamsForForwarding: Pick<
      Mock<(params: { rawParams: unknown }) => { ok: boolean; params: unknown }>,
      "mockImplementationOnce"
    >;
  };
  invokeNode: ReturnType<typeof createNodeInvokeTestHarness>;
}): void {
  it.each(["terminal.upload"])(
    "blocks external %s upload bytes before node lookup, including spoofed internal params",
    async (command) => {
      mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: false } } });
      const nodeRegistry = { get: vi.fn(), invoke: vi.fn() };
      const respond = await invokeNode({
        nodeRegistry,
        client: createOperatorClient({ scopes: ["operator.admin"] }),
        requestParams: {
          command,
          params: { contentBase64: "", internal: { syntheticClient: true } },
        },
      });
      expect(firstRespondCall(respond)).toMatchObject([
        false,
        undefined,
        {
          code: "FORBIDDEN",
          details: { code: "UPLOADS_DISABLED" },
        },
      ]);
      expect(nodeRegistry.get).not.toHaveBeenCalled();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    },
  );

  it("rejects terminal bytes when uploads are disabled during dispatch preparation", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: true } } });
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementationOnce(({ rawParams }) => {
      mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: false } } });
      return { ok: true, params: rawParams };
    });
    const nodeRegistry = {
      get: vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
      invoke: vi.fn(),
    };
    const respond = await invokeNode({
      nodeRegistry,
      client: createOperatorClient({ scopes: ["operator.admin"] }),
      requestParams: {
        nodeId: "upload-node",
        command: "terminal.upload",
        params: { name: "proof", contentBase64: "cHJvb2Y=" },
      },
    });
    expect(firstRespondCall(respond)).toMatchObject([
      false,
      undefined,
      { details: { code: "UPLOADS_DISABLED" } },
    ]);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("preserves terminal upload dispatch for internal services", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: false } } });
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
    const nodeRegistry = {
      get: vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payloadJSON: '{"path":"/uploads/proof"}' }),
    };
    const client = createOperatorClient({ scopes: ["operator.admin"] });
    const respond = await invokeNode({
      nodeRegistry,
      client: { ...client, internal: { syntheticClient: true } },
      requestParams: {
        nodeId: "upload-node",
        command: "terminal.upload",
        params: { name: "proof", contentBase64: "cHJvb2Y=" },
      },
    });
    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
  });

  it("pauses node CUA at the native desktop control admission before dispatch", async () => {
    const beginComputerRequest = vi
      .fn()
      .mockRejectedValue(new Error("Computer input paused while the operator has control"));
    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "computer-node",
        connId: "node-conn",
        commands: ["computer.act"],
        platform: "macOS 26.0.0",
      })),
      invoke: vi.fn(),
    };
    const respond = await invokeNode({
      nodeRegistry,
      client: createOperatorClient(),
      desktopService: { beginComputerRequest },
      requestParams: {
        nodeId: "computer-node",
        command: "computer.act",
        params: { executionId: "execution", action: "type", text: "hello" },
      },
    });
    expect(beginComputerRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "computer-node",
        connId: "node-conn",
        command: "computer.act",
      }),
    );
    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(firstRespondCall(respond)[2]?.message).toContain("operator has control");
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "releases native computer admission and refreshes observation only on success (%s)",
    async (ok) => {
      const operation = {
        signal: new AbortController().signal,
        assertCurrent: vi.fn(),
        complete: vi.fn(),
        release: vi.fn(),
      };
      const beginComputerRequest = vi.fn().mockResolvedValue(operation);
      const nodeRegistry = {
        get: vi.fn(() => ({
          nodeId: "computer-node",
          connId: "node-conn",
          commands: ["screen.snapshot"],
          platform: "macOS 26.0.0",
        })),
        invoke: vi.fn(async () => ({
          ok,
          payloadJSON: '{"format":"png"}',
          ...(ok ? {} : { error: { code: "FAILED", message: "screenshot failed" } }),
        })),
      };
      await invokeNode({
        nodeRegistry,
        client: createOperatorClient(),
        desktopService: { beginComputerRequest },
        requestParams: {
          nodeId: "computer-node",
          command: "screen.snapshot",
          params: { executionId: "execution" },
        },
      });
      expect(operation.release).toHaveBeenCalledOnce();
      expect(operation.complete).toHaveBeenCalledTimes(ok ? 1 : 0);
      expect(nodeRegistry.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ signal: operation.signal }),
      );
    },
  );
}
