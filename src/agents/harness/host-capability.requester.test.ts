import { describe, expect, it, vi, type TestContext } from "vitest";
import { withCommandSenderAuthority } from "../../auto-reply/command-sender-authority.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import * as beforeToolCall from "../agent-tools.before-tool-call.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

async function admittedAttempt(test: TestContext, runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  test.onTestFinished(() => {
    admission.close();
    resetAgentRunRegistryForTest();
  });
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId,
    cwd: "/attempt/worktree",
    workspaceDir: "/workspace",
    currentChannelId: "chat-1",
    messageChannel: "telegram",
    admittedRunContext: await admission.admit("plugin-harness", `harness-${runId}`),
  };
}

describe("agent harness requester authority", () => {
  it("exposes the retained live profile authority to native tool hooks", async (test) => {
    using runBefore = vi
      .spyOn(beforeToolCall, "runBeforeToolCallHook")
      .mockImplementation(async ({ params }) => ({ blocked: false, params }));
    let profileId: string | undefined = "profile-human";
    const attempt = await admittedAttempt(test, "run-profile");
    const host = createAgentHarnessHostCapabilities({
      attempt: withCommandSenderAuthority({ ...attempt, senderId: "forged" }, () =>
        profileId ? { profileId } : undefined,
      ),
      pluginId: "codex",
    });
    try {
      await host.capabilities.runBeforeToolCall({ toolName: "computer", params: {} });
      const requester = runBefore.mock.lastCall?.[0].ctx?.requester;
      expect(requester?.getAuthenticatedIdentity?.()).toEqual({ profileId: "profile-human" });
      profileId = undefined;
      expect(requester?.getAuthenticatedIdentity?.()).toBeUndefined();
    } finally {
      host.close();
    }
  });
});
