import { describe, expect, it, vi } from "vitest";
import type { MattermostMediaInfo } from "./monitor-resources.js";
import { resolveMattermostPreflightAudioTranscript } from "./preflight-audio.js";

const transcribeFirstAudio = vi.hoisted(() => vi.fn(async () => "never"));

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: ((params) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio,
      })) satisfies typeof actual.createChannelPreflightAudio,
  };
});

const request = {
  cfg: {},
  accountId: "default",
  originatingTo: "channel:chan-1",
  sessionKey: "mattermost:default:channel:chan-1",
};
const image = {
  path: "/tmp/a.png",
  contentType: "image/png",
  kind: "image",
} as MattermostMediaInfo;
const voice = {
  path: "/tmp/v.ogg",
  contentType: "audio/ogg; codecs=opus",
  kind: "audio",
} as MattermostMediaInfo;

describe("mattermost preflight audio", () => {
  it.each([
    { label: "audio that failed to download", media: [{ ...voice, path: undefined }] },
    { label: "non-audio attachments", media: [image] },
  ])("skips $label without transcribing", async ({ media }) => {
    await expect(
      resolveMattermostPreflightAudioTranscript({ ...request, media }),
    ).resolves.toBeUndefined();
    expect(transcribeFirstAudio).not.toHaveBeenCalled();
  });
});
