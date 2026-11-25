import { describe, expect, it } from "vitest";
import {
  getCommandSenderAuthority,
  withCommandSenderAuthority,
} from "../../auto-reply/command-sender-authority.js";
import { buildCommandAttemptToolContext } from "./attempt-tool-context.js";

const baseParams = {
  cfg: {},
  messageChannel: "webchat",
  opts: { message: "hello" },
  spawnedBy: undefined,
};

describe("buildCommandAttemptToolContext", () => {
  it("carries the authenticated command sender from the admitted run context", () => {
    const identity = Object.freeze({ profileId: "profile-a", userId: "user-a" });
    const context = buildCommandAttemptToolContext({
      ...baseParams,
      runContext: withCommandSenderAuthority({ senderId: "client-a" }, () => identity),
    });
    expect(getCommandSenderAuthority(context)?.()).toBe(identity);
    expect(context.senderId).toBe("client-a");
  });

  it("leaves the command sender absent when the run context has none", () => {
    const context = buildCommandAttemptToolContext({
      ...baseParams,
      runContext: { senderId: "client-a" },
    });
    expect(getCommandSenderAuthority(context)).toBeUndefined();
  });
});
