/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionParticipantIdentity } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestChatPane, createSessionCapabilityFixture } from "./chat-pane.test-support.ts";
import { resolveChatSessionParticipantLabels } from "./chat-participant-labels.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";

const observation = {
  type: "observation",
  pluginId: "mattermost",
  accountId: "workspace",
  senderKind: "human",
  id: "opaque-channel-user",
} as const;
const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
});

function senderMessage(identity: SessionParticipantIdentity = observation, name = "Ada") {
  return {
    role: "user",
    content: "Hello",
    __openclaw: { senderIdentity: identity, senderId: identity.id, senderName: name },
  };
}

function mountParticipants() {
  const { pane, state } = createTestChatPane({
    client: { instanceId: "self" } as GatewayBrowserClient,
    sessions: createSessionCapabilityFixture(),
  });
  state.currentSessionId = "current-session";
  state.settings = {} as ChatPageHost["settings"];
  const session: GatewaySessionRow = {
    key: state.sessionKey,
    sessionId: state.currentSessionId,
    kind: "group",
    updatedAt: 1,
    participants: [{ identity: observation }],
    participantCount: 1,
  };
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const renderHeader = async () => {
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    const facepile = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "openclaw-viewer-facepile.chat-pane__participants",
    );
    await facepile?.updateComplete;
    const avatar = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "openclaw-viewer-avatar",
    );
    await avatar?.updateComplete;
  };
  const labelText = () => container.querySelector(".viewer-avatar")?.getAttribute("aria-label");
  return { state, session, container, renderHeader, labelText };
}

function resolveLabel(messages: unknown[], row: Partial<GatewaySessionRow> = {}) {
  return resolveChatSessionParticipantLabels(
    {
      key: "current",
      sessionId: "current-session",
      kind: "group",
      updatedAt: 1,
      participants: [{ identity: observation }],
      ...row,
    },
    { sessionKey: "current", currentSessionId: "current-session", chatMessages: messages },
  )?.participants?.[0]?.label;
}

describe("chat header channel participant names", () => {
  it("hydrates the header after history arrives without changing participant identity or stored metadata", async () => {
    const mounted = mountParticipants();
    await mounted.renderHeader();
    expect(mounted.labelText()).toBe(observation.id);
    mounted.state.chatMessages = [senderMessage()];
    await mounted.renderHeader();
    expect(mounted.labelText()).toBe("Ada");
    expect(mounted.session.participants).toEqual([{ identity: observation }]);
    expect(mounted.container.querySelector(".chat-pane__participants a")).toBeNull();
    mounted.state.chatMessages = [];
    await mounted.renderHeader();
    expect(mounted.labelText()).toBe(observation.id);
  });

  it.each([
    { ...observation, accountId: "other-workspace" },
    { ...observation, pluginId: "another-channel" },
    { ...observation, senderKind: "bot" as const },
    { type: "profile" as const, id: observation.id },
    {
      type: "remote" as const,
      pluginId: "mattermost",
      domain: "workspace",
      idKind: "user",
      id: observation.id,
    },
  ])(
    "does not borrow a name from another identity namespace: $type $accountId $pluginId $senderKind",
    (identity) => {
      expect(resolveLabel([senderMessage(identity)])).toBeUndefined();
    },
  );

  it("uses the newest available sender name and preserves an authoritative participant label", () => {
    const messages = [senderMessage(observation, "Old name"), senderMessage(observation, "Ada")];
    expect(resolveLabel(messages)).toBe("Ada");
    expect(
      resolveLabel(messages, { participants: [{ identity: observation, label: "Gateway name" }] }),
    ).toBe("Gateway name");
  });

  it("uses a broker-enriched profile name only with its preserved matching observation", () => {
    const message = {
      role: "user",
      content: "Hello",
      __openclaw: {
        senderIdentity: { type: "profile", id: "native-profile" },
        senderId: "native-profile",
        senderName: "Ada",
        senderObservation: observation,
      },
    };
    expect(resolveLabel([message])).toBe("Ada");
    for (const patch of [
      { senderObservation: { ...observation, accountId: "other-workspace" } },
      { senderId: "different-profile" },
    ]) {
      expect(
        resolveLabel([{ ...message, __openclaw: { ...message["__openclaw"], ...patch } }]),
      ).toBeUndefined();
    }
  });

  it.each(["key", "sessionId"] as const)("does not borrow history from a replaced %s", (field) => {
    expect(resolveLabel([senderMessage()], { [field]: "replacement" })).toBeUndefined();
  });

  it("does not use assistant or unqualified sender attribution", () => {
    expect(
      resolveLabel([
        { ...senderMessage(), role: "assistant" },
        {
          role: "user",
          content: "Hello",
          __openclaw: { senderId: observation.id, senderName: "Ada" },
        },
        {
          ...senderMessage(),
          __openclaw: { ...senderMessage()["__openclaw"], senderId: "different-id" },
        },
      ]),
    ).toBeUndefined();
  });
});
