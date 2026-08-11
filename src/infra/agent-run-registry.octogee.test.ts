import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentEventsForTest } from "./agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "./agent-run-registry.js";

describe("sidecar agent run visibility", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    process.env.OPENCLAW_BROADCAST_ALL_AGENT_RUNS = "1";
  });

  afterEach(() => {
    delete process.env.OPENCLAW_BROADCAST_ALL_AGENT_RUNS;
  });

  it("covers registered and freshly claimed runs without mutating caller state", () => {
    const registeredContext = {
      sessionKey: "session-mattermost",
      isControlUiVisible: false,
    };
    const claimedContext = {
      sessionKey: "session-mattermost-claimed",
      isControlUiVisible: false,
    };

    registerAgentRunContext("run-sidecar", registeredContext);
    claimAgentRunContext("run-sidecar-claimed", claimedContext, {
      ownsContext: true,
      trackOwner: true,
    });

    expect(getAgentRunContext("run-sidecar")?.isControlUiVisible).toBe(true);
    expect(getAgentRunContext("run-sidecar-claimed")?.isControlUiVisible).toBe(true);
    expect(registeredContext.isControlUiVisible).toBe(false);
    expect(claimedContext.isControlUiVisible).toBe(false);
  });
});
