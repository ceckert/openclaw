import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../auto-reply/command-sender-authority.js";
import { resolveChatSendCallerContext } from "../gateway/server-methods/gateway-client-identity.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookToolContext } from "../plugins/hook-types.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetGlobalHookRunner);

describe("tool requester profile authority", () => {
  it("retains browser attestation during tool execution and revokes it on disconnect", async () => {
    const lifetime = new AbortController();
    const client: GatewayClient = {
      authenticatedUserId: "human@example.test",
      authenticatedUserProfile: {
        profileId: "profile-human",
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
      connectionSignal: lifetime.signal,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.write"],
      },
    };
    const workspaceDir = tempDirs.make("openclaw-hook-profile-");
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello");
    let requester: PluginHookToolContext["requester"];
    const handler = vi.fn(async (_event: unknown, ctx: PluginHookToolContext) => {
      requester = ctx.requester;
      expect(requester?.getAuthenticatedIdentity?.()).toEqual({
        profileId: "profile-human",
        userId: "human@example.test",
      });
      expect(requester?.senderId).toBe("profile-forged");
    });
    const registry = createMockPluginRegistry([]);
    registry.typedHooks.push({
      hookName: "before_tool_call",
      handler,
      pluginId: "test-plugin",
      source: "test",
    });
    initializeGlobalHookRunner(registry);
    const source = resolveChatSendCallerContext(client);
    const tools = createOpenClawCodingTools(
      withCommandSenderAuthority(
        {
          workspaceDir,
          agentId: "main",
          sessionKey: "agent:main:profile-test",
          messageChannel: "webchat",
          senderId: "profile-forged",
        },
        getCommandSenderAuthority(source),
      ),
    );
    const readTool = tools.find((tool) => tool.name === "read");
    if (!readTool) {
      throw new Error("missing read tool");
    }
    await readTool.execute("tool-hook-profile", { path: "note.txt" }, lifetime.signal);
    expect(handler).toHaveBeenCalledOnce();
    lifetime.abort();
    expect(requester?.getAuthenticatedIdentity?.()).toBeUndefined();
  });

  it("keeps channel requester fields separate from browser authority", async () => {
    const workspaceDir = tempDirs.make("openclaw-hook-unattested-");
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello");
    const handler = vi.fn(async (_event: unknown, ctx: PluginHookToolContext) => {
      expect(ctx.requester?.getAuthenticatedIdentity).toBeUndefined();
      expect(ctx.requester).toMatchObject({
        channel: "mattermost",
        accountId: "coach",
        senderId: "profile-human",
        senderIsOwner: true,
      });
    });
    const registry = createMockPluginRegistry([]);
    registry.typedHooks.push({
      hookName: "before_tool_call",
      handler,
      pluginId: "test-plugin",
      source: "test",
    });
    initializeGlobalHookRunner(registry);
    const readTool = createOpenClawCodingTools({
      workspaceDir,
      senderId: "profile-human",
      messageChannel: "mattermost",
      agentAccountId: "coach",
      senderIsOwner: true,
    }).find((tool) => tool.name === "read");
    if (!readTool) {
      throw new Error("missing read tool");
    }
    await readTool.execute("tool-hook-unattested", { path: "note.txt" });
    expect(handler).toHaveBeenCalledOnce();
  });
});
