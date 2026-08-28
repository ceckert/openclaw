import { describe, expect, it } from "vitest";
import {
  mergeVerifiedMattermostAgentRunProps,
  type MattermostAgentRunRefV3,
} from "./agent-run-ref.js";

const running: MattermostAgentRunRefV3 = {
  schemaVersion: 3,
  projectionKind: "run",
  conversationId: "channel-1",
  turnId: "turn-1",
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  origin: "human",
  status: "running",
  mainChannelId: "channel-1",
  mainRootPostId: "turn-1",
  inputPostId: "turn-1",
  activityChannelId: "channel-1",
  activityRootPostId: "turn-1",
  attention: "routine",
};

describe("mergeVerifiedMattermostAgentRunProps", () => {
  it("preserves current props and controls while authoritative terminal v3 fields win", () => {
    const terminal: MattermostAgentRunRefV3 = {
      ...running,
      status: "failed",
      attention: "failure",
    };

    expect(
      mergeVerifiedMattermostAgentRunProps({
        post: {
          id: "response-1",
          channel_id: "channel-1",
          root_id: "turn-1",
          props: {
            retained: { value: true },
            attachments: [{ actions: [{ id: "ocstop" }] }],
            octogee: {
              ...running,
              controlId: "stop-1",
              controlResourceDigest: "digest-1",
            },
          },
        },
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: terminal },
      }),
    ).toEqual({
      retained: { value: true },
      attachments: [{ actions: [{ id: "ocstop" }] }],
      octogee: {
        ...terminal,
        controlId: "stop-1",
        controlResourceDigest: "digest-1",
      },
    });
  });

  it("rejects a post, thread, or successor identity mismatch", () => {
    const post = {
      id: "response-1",
      channel_id: "channel-1",
      root_id: "turn-1",
      props: { octogee: running },
    };
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "other-response",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: running },
      }),
    ).toThrow("post binding mismatch");
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "other-turn",
        nextProps: { octogee: running },
      }),
    ).toThrow("post binding mismatch");
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: { ...running, runId: "run-2" } },
      }),
    ).toThrow("run identity mismatch");
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: { ...running, agentId: "agent-2" } },
      }),
    ).toThrow("run identity mismatch");
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: { ...running, sessionKey: "session-2" } },
      }),
    ).toThrow("run identity mismatch");
    expect(() =>
      mergeVerifiedMattermostAgentRunProps({
        post,
        expectedPostId: "response-1",
        expectedChannelId: "channel-1",
        expectedRootId: "turn-1",
        nextProps: { octogee: { ...running, activityChannelId: "other-channel" } },
      }),
    ).toThrow("run identity mismatch");
  });
});
