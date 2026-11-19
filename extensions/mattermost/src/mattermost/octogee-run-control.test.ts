import { expect, it, vi } from "vitest";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { resolveOctogeeRunInput } from "./octogee-run-control.js";

it("uses the verified Mattermost sender and only applies a decision returned by the Gateway", async () => {
  const request = vi.fn();
  const gateway = { request } as unknown as MattermostMonitorContext["core"]["gateway"];
  const input = { gateway, senderId: "verified-sender", sessionKey: "native-channel-session" };
  await expect(resolveOctogeeRunInput({ ...input, request: undefined })).resolves.toBeUndefined();
  await expect(
    resolveOctogeeRunInput({ ...input, request: { mode: "stop", runId: "run-1" } }),
  ).resolves.toBeNull();
  expect(request).not.toHaveBeenCalled();

  request.mockResolvedValueOnce({ allowed: false });
  await expect(
    resolveOctogeeRunInput({
      ...input,
      request: {
        mode: "steer",
        runId: "run-1",
        senderId: "forged-owner",
        allowCollaborativeSteering: true,
      },
    }),
  ).resolves.toBeNull();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "octogee.activity.authorizeChannelRunInput",
    {
      mode: "steer",
      runId: "run-1",
      senderId: "verified-sender",
      sessionKey: "native-channel-session",
    },
    expect.objectContaining({ scopes: ["operator.admin"] }),
  );

  request.mockResolvedValueOnce({ allowed: true, allowCollaborativeSteering: false });
  await expect(
    resolveOctogeeRunInput({
      ...input,
      request: { mode: "queue", runId: "run-1" },
    }),
  ).resolves.toEqual({ mode: "followup", runId: "run-1" });
});
