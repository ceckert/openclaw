import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "../desktop/node-source-context.js";
import type { NodeDesktopService } from "../desktop/node-source.js";
import type { NodeInvokeParams, NodeInvokeResult } from "../node-invoke.types.js";
import type { NodeRegistry } from "../node-registry.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

export type RespondCall = Parameters<GatewayRequestHandlerOptions["respond"]>;

export async function invokeNodeRequest(
  handler: GatewayRequestHandler,
  context: GatewayRequestHandlerOptions["context"],
  client: GatewayRequestHandlerOptions["client"],
  method: string,
  params: Record<string, unknown>,
  requestId = method,
) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: requestId, method, params },
    params,
    context,
    client,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

type MockCallSource = Pick<Mock, "mock">;

export function expectNodeReply(
  respond: GatewayRequestHandlerOptions["respond"],
  payload: unknown,
) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

export function expectNodeFailure(
  respond: GatewayRequestHandlerOptions["respond"],
  error: Record<string, unknown>,
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

export function bindNodeRegistry(registry: NodeRegistry) {
  return {
    get: registry.get.bind(registry),
    getForPairingGeneration: registry.getForPairingGeneration.bind(registry),
    invoke: registry.invoke.bind(registry),
  };
}

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

export function createNodeInvokeTestHarness({
  getRuntimeConfig,
  nodeHandlers,
}: {
  getRuntimeConfig: () => unknown;
  nodeHandlers: (typeof import("./nodes.js"))["nodeHandlers"];
}) {
  return async (params: {
    nodeRegistry: {
      get: (nodeId: string) => TestNodeSession | undefined;
      getForPairingGeneration?: (
        nodeId: string,
        pairingGeneration: string,
      ) => TestNodeSession | undefined;
      invoke: (payload: NodeInvokeParams) => Promise<NodeInvokeResult>;
    };
    client?: unknown;
    respond?: ReturnType<typeof vi.fn>;
    requestId?: string;
    signal?: AbortSignal;
    requestParams?: Partial<Record<string, unknown>>;
    validateAgentRuntimeApprovalAuthority?: () => boolean;
    desktopService?: Pick<NodeDesktopService, "beginComputerRequest">;
    execApprovalManager?: {
      projectDecisionIfActive: (id: string, decision: string) => string | null;
      retainForHandoff?: (id: string) => (() => void) | null;
    };
  }) => {
    const respond = params.respond ?? vi.fn();
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
      params: {
        nodeId: "ios-node-1",
        command: "camera.capture",
        params: { quality: "high" },
        timeoutMs: 5000,
        idempotencyKey: "idem-node-invoke",
        ...params.requestParams,
      },
      respond: respond as never,
      context: {
        nodeRegistry,
        [NODE_DESKTOP_SERVICE_CONTEXT]: params.desktopService,
        execApprovalManager,
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig,
        validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
      } as never,
      client: (params.client ?? null) as never,
      signal: params.signal,
      req: { type: "req", id: params.requestId ?? "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });
    return respond;
  };
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
  const setUploads = (enabled: boolean) =>
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled } } });
  it.each(["before lookup", "during preparation", "internal service"])(
    "enforces terminal upload policy: %s",
    async (stage) => {
      const internal = stage === "internal service";
      setUploads(stage === "during preparation");
      const nodeRegistry = {
        get:
          stage === "before lookup"
            ? vi.fn()
            : vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
        invoke: vi.fn(),
      };
      if (stage !== "before lookup") {
        mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
      }
      if (stage === "during preparation") {
        mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementationOnce(({ rawParams }) => {
          setUploads(false);
          return { ok: true, params: rawParams };
        });
      }
      if (internal) {
        nodeRegistry.invoke.mockResolvedValue({
          ok: true,
          payloadJSON: '{"path":"/uploads/proof"}',
        });
      }
      const bytes =
        stage === "before lookup"
          ? { contentBase64: "", internal: { syntheticClient: true } }
          : { name: "proof", contentBase64: "cHJvb2Y=" };
      const respond = await invokeNode({
        nodeRegistry,
        client: {
          ...createOperatorClient({ scopes: ["operator.admin"] }),
          internal: internal ? { syntheticClient: true } : {},
        },
        requestParams: { nodeId: "upload-node", command: "terminal.upload", params: bytes },
      });
      if (internal) {
        expect(firstRespondCall(respond)[0]).toBe(true);
        expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
      } else {
        expect(firstRespondCall(respond)).toMatchObject([
          false,
          undefined,
          {
            ...(stage === "before lookup" ? { code: "FORBIDDEN" } : {}),
            details: { code: "UPLOADS_DISABLED" },
          },
        ]);
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      }
      if (stage === "before lookup") {
        expect(nodeRegistry.get).not.toHaveBeenCalled();
      }
    },
  );
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
