import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeChannelConsultIngress, registerChannelConsultIngress } from "./consult-ingress.js";

const identity = {
  channel: "mattermost",
  accountId: "default",
  channelId: "coach",
  senderId: "builder",
  agentId: "coach-agent",
  sessionKey: "agent:coach-agent:mattermost:group:coach",
  text: "Show me the news",
};
const handles: Array<{ dispose: () => void }> = [];
function register(overrides = {}) {
  const onAgentRunStart = vi.fn();
  const handle = registerChannelConsultIngress({
    identity,
    isCurrent: () => true,
    callbacks: { onAgentRunStart },
    gatewayUiCommandTarget: { connId: "live-connection", profileId: "builder" },
    gatewayClientCaps: ["ui-commands"],
    ...overrides,
  });
  handles.push(handle);
  return { ...handle, onAgentRunStart };
}
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  vi.useRealTimers();
});

describe("channel consult ingress custody", () => {
  it("attaches the original requester and callbacks once to the exact admitted message", () => {
    const handle = register();
    const binding = consumeChannelConsultIngress({ token: handle.token, identity });
    expect(binding?.context).toEqual({
      GatewayUiCommandTarget: { connId: "live-connection", profileId: "builder" },
      GatewayClientCaps: ["ui-commands"],
    });
    binding?.callbacks.onAgentRunStart?.("exact-run");
    expect(handle.onAgentRunStart).toHaveBeenCalledWith("exact-run");
    expect(consumeChannelConsultIngress({ token: handle.token, identity })).toBeUndefined();
  });
  it.each([
    "channel",
    "accountId",
    "channelId",
    "senderId",
    "agentId",
    "sessionKey",
    "text",
  ] as const)("refuses another %s without consuming the rightful attachment", (field) => {
    const handle = register();
    expect(
      consumeChannelConsultIngress({
        token: handle.token,
        identity: { ...identity, [field]: "other" },
      }),
    ).toBeUndefined();
    expect(consumeChannelConsultIngress({ token: handle.token, identity })).toBeDefined();
  });
  it("does not grant authority from copied properties without a live host-issued token", () => {
    expect(consumeChannelConsultIngress({ token: "client-invented", identity })).toBeUndefined();
    expect(
      consumeChannelConsultIngress({ token: { connId: "live-connection" }, identity }),
    ).toBeUndefined();
  });
  it("expires an unconsumed attachment", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const handle = register({ callbacks: { onError } });
    vi.advanceTimersByTime(30_001);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Channel consult admission expired" }),
    );
    expect(consumeChannelConsultIngress({ token: handle.token, identity })).toBeUndefined();
  });
  it("revokes aborted and disconnected callers before ingress", () => {
    const controller = new AbortController();
    const handle = register({ signal: controller.signal });
    controller.abort();
    expect(consumeChannelConsultIngress({ token: handle.token, identity })).toBeUndefined();
    let current = true;
    const second = register({ isCurrent: () => current });
    current = false;
    expect(consumeChannelConsultIngress({ token: second.token, identity })).toBeUndefined();
  });
  it("does not mutate requester capabilities through external references", () => {
    const caps = ["ui-commands"];
    const target = { connId: "original" };
    const handle = register({ gatewayClientCaps: caps, gatewayUiCommandTarget: target });
    caps.push("arbitrary");
    target.connId = "other";
    expect(consumeChannelConsultIngress({ token: handle.token, identity })?.context).toEqual({
      GatewayUiCommandTarget: { connId: "original" },
      GatewayClientCaps: ["ui-commands"],
    });
  });
});
