import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { setActiveEmbeddedRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { withCommandSenderAuthority } from "../../auto-reply/command-sender-authority.js";
import { consumeChannelConsultIngress } from "../../channels/consult-ingress.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";

const { config, coreParams, deferred, mocks } = await vi.hoisted(
  () => import("./client-gateway-control.agent-consult.test-support.js"),
);

vi.mock("../../agents/admitted-run-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/admitted-run-context.js")>()),
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";
import {
  resolveTalkAgentConsultAuthority,
  type TalkAgentConsultAuthority,
} from "./client-gateway-control.js";

function createChannelAuthority(isCurrent = () => true): TalkAgentConsultAuthority {
  const caller: NonNullable<TalkAgentConsultAuthority["replyCaller"]> = {
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    ChatType: "direct",
    ApprovalReviewerDeviceId: undefined,
    GatewayClientCaps: [],
    GatewayClientScopes: ["operator.write"],
  };
  return {
    senderIsOwner: true,
    replyCaller: withCommandSenderAuthority(caller, () =>
      isCurrent() ? { profileId: "p1", userId: "u1" } : undefined,
    ),
  };
}

function createRunner(
  registerRun = vi.fn(),
  authority: TalkAgentConsultAuthority = { senderIsOwner: false, toolsAllow: ["read"] },
  options: {
    ownerConnId?: string;
    isRunCurrent?: (runId: string) => boolean;
    createAgentConsultAdapter?: RealtimeVoiceProviderPlugin["createAgentConsultAdapter"];
    getVoiceSessionId?: () => string | undefined;
  } = {},
) {
  return createTalkClientAgentConsultRunner({
    config,
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "main",
      canonicalKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
    },
    authority,
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun,
    ...options,
  });
}

describe("Talk channel agent consult admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    mocks.createOperationalRunInstanceRef.mockImplementation((runId: string) => ({
      instanceId: `instance:${runId}`,
      runId,
    }));
    mocks.prepareAgentRunAdmission.mockImplementation(
      (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
        operationalRunInstance: params.operationalRunInstance,
        admit: vi.fn(),
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
      ok: true,
      mode: "steer",
      sessionKey: "agent:researcher:talk",
      sessionId: "session-talk",
      active: true,
      queued: true,
      target: "embedded",
      message: "Steering accepted.",
      speak: true,
      show: true,
      suppress: false,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 60_000 });
      await params.agentRuntime.runEmbeddedAgent({
        ...coreParams,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      });
      return { text: "done" };
    });
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetClientVoiceConfirmationStateForTest();
  });

  it("routes an adapter-backed consult through authenticated channel ingress instead of a direct chat run", async () => {
    const registerRun = vi.fn();
    const run = vi.fn(async () => ({ text: "channel response" }));
    const createAgentConsultAdapter = vi.fn(
      (
        _context: Parameters<
          NonNullable<RealtimeVoiceProviderPlugin["createAgentConsultAdapter"]>
        >[0],
      ) => ({ run }),
    );
    const authority = createChannelAuthority();
    const runner = createRunner(registerRun, authority, { createAgentConsultAdapter });
    await expect(runner.runPrompt({ prompt: "Open the news" })).rejects.toThrow(
      "did not bind a native run",
    );
    expect(createAgentConsultAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "researcher", sessionKey: "agent:researcher:talk" }),
    );
    expect(createAgentConsultAdapter.mock.calls[0]![0].getAuthenticatedUserId()).toBe("u1");
    expect(createAgentConsultAdapter.mock.calls[0]![0].getAuthenticatedVoiceSessionId()).toBe(
      "voice-session",
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Open the news", bindRun: expect.any(Function) }),
    );
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each(["replaced", "aborted", "unauthenticated"] as const)(
    "revokes both retained identity accessors when the voice caller is %s",
    async (invalidation) => {
      let voiceSessionId = "voice-session";
      let current = true;
      const controller = new AbortController();
      const runner = createRunner(
        vi.fn(),
        createChannelAuthority(() => current),
        {
          getVoiceSessionId: () => voiceSessionId,
          createAgentConsultAdapter: (context) => ({
            run: async () => {
              expect(context.getAuthenticatedVoiceSessionId()).toBe("voice-session");
              if (invalidation === "replaced") {
                voiceSessionId = "replacement-session";
              } else if (invalidation === "aborted") {
                controller.abort();
              } else {
                current = false;
              }
              expect(() => context.getAuthenticatedUserId()).toThrow();
              expect(() => context.getAuthenticatedVoiceSessionId()).toThrow();
              return { text: "" };
            },
          }),
        },
      );
      await expect(
        runner.runPrompt({ prompt: "Open the news", signal: controller.signal }),
      ).rejects.toThrow("did not bind a native run");
    },
  );

  it("captures the original Control UI presentation target for channel voice", () => {
    const client = sharingPolicyClient({
      user: "voice-user",
      deviceId: "voice-device",
      scopes: ["operator.write"],
    });
    client.connId = "voice-connection";
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    expect(authority).toMatchObject({
      gatewayUiCommandTarget: {
        connId: client.connId,
        profileId: client.authenticatedUserProfile?.profileId,
      },
    });
    client.invalidated = true;
    expect(resolveTalkAgentConsultAuthority(client.connect.scopes, client)).not.toHaveProperty(
      "gatewayUiCommandTarget",
    );
  });

  it("aborts its exact channel run if Talk registration fails during adoption", async () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "run-channel", abort });
    setActiveEmbeddedRun("session-channel", handle, "agent:researcher:talk");
    const authority = createChannelAuthority();
    const runner = createRunner(
      vi.fn(() => {
        throw new Error("registration failed");
      }),
      authority,
      {
        createAgentConsultAdapter: () => ({
          run: async ({ bindRun }) => {
            bindRun("run-channel");
            return { text: "never" };
          },
        }),
      },
    );
    await expect(runner.runPrompt({ prompt: "Open the news" })).rejects.toThrow(
      "registration failed",
    );
    expect(abort).toHaveBeenCalledOnce();
  });

  it("adopts only the matching channel run and retains native completion and cancellation", async () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "run-channel", abort });
    const done = deferred<void>();
    const bound = deferred<void>();
    const signal = new AbortController();
    const authority = createChannelAuthority();
    const factory: NonNullable<RealtimeVoiceProviderPlugin["createAgentConsultAdapter"]> = () => ({
      run: async (request) => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "researcher",
            sessionKey: "agent:researcher:talk",
            operationalRunInstance: { instanceId: "channel-instance", runId: "run-channel" },
            embeddedRunToolAuthorityBinding: () => ({
              source: "reply",
              project: () => "authority",
              assertActive: () => {},
            }),
          },
          () => setActiveEmbeddedRun("session-channel", handle, "agent:researcher:talk"),
        );
        request.bindRun("run-channel");
        bound.resolve();
        await done.promise;
        return { text: "Channel result" };
      },
    });
    const registerRun = vi.fn();
    const runner = createRunner(registerRun, authority, {
      ownerConnId: "owner",
      createAgentConsultAdapter: factory,
    });
    runner.runPrompt.adoptCompletionClaims();
    const result = runner.runPrompt({ prompt: "Open the news", signal: signal.signal });
    await bound.promise;
    expect(registerRun).toHaveBeenCalledWith({ runId: "run-channel" });
    signal.abort();
    expect(abort).toHaveBeenCalledOnce();
    done.resolve();
    await expect(result).rejects.toThrow();
    expect(runner.runPrompt.claimAppend()).toBe(false);
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("lets native channel completion finish when its final reply observer has detached", async () => {
    let current = true;
    const onReply = vi.fn();
    const onComplete = vi.fn();
    const authority = createChannelAuthority(() => current);
    const runner = createRunner(vi.fn(), authority, {
      createAgentConsultAdapter: (context) => ({
        run: async () => {
          const identity = {
            channel: "mattermost",
            accountId: "coach",
            channelId: "channel",
            senderId: "sender",
            text: "Open the news",
          };
          const attachment = context.attachChannelIngress(identity, {
            onRunStarted: vi.fn(),
            onReply,
            onComplete,
            onError: vi.fn(),
          });
          const admitted = consumeChannelConsultIngress({
            token: attachment.token,
            identity: { ...identity, agentId: "researcher", sessionKey: "agent:researcher:talk" },
          });
          expect(admitted).toBeDefined();
          current = false;
          admitted!.callbacks.onFinalReply?.({ text: "Delivered to the channel" });
          admitted!.callbacks.onComplete?.();
          attachment.dispose();
          return { text: "" };
        },
      }),
    });
    await expect(runner.runPrompt({ prompt: "Open the news" })).rejects.toThrow(
      "did not bind a native run",
    );
    expect(onReply).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("refuses to bind a native run from a different session", async () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "foreign-run", abort });
    setActiveEmbeddedRun("foreign-session", handle, "agent:other:main");
    const authority = createChannelAuthority();
    const runner = createRunner(vi.fn(), authority, {
      createAgentConsultAdapter: () => ({
        run: async (request) => {
          request.bindRun("foreign-run");
          return { text: "wrong" };
        },
      }),
    });
    await expect(runner.runPrompt({ prompt: "Open the news" })).rejects.toThrow(
      "does not match its session",
    );
    expect(abort).not.toHaveBeenCalled();
  });

  it("rejects channel consult without live authenticated sender authority", async () => {
    const createAgentConsultAdapter = vi.fn(() => ({ run: vi.fn() }));
    await expect(
      createRunner(vi.fn(), { senderIsOwner: true }, { createAgentConsultAdapter }).runPrompt({
        prompt: "Open the news",
      }),
    ).rejects.toThrow("authenticated user");
    expect(createAgentConsultAdapter).not.toHaveBeenCalled();
  });
});
