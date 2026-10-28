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

const attachment = (contentType: string, path?: string) =>
  ({ path, contentType, kind: "audio" }) as MattermostMediaInfo;

describe("mattermost preflight audio", () => {
  it.each([
    { label: "audio that failed to download", media: [attachment("audio/ogg; codecs=opus")] },
    { label: "non-audio attachments", media: [attachment("image/png", "/tmp/a.png")] },
  ])("skips $label without transcribing", async ({ media }) => {
    await expect(
      resolveMattermostPreflightAudioTranscript({
        cfg: {},
        accountId: "default",
        originatingTo: "channel:chan-1",
        sessionKey: "mattermost:default:channel:chan-1",
        media,
      }),
    ).resolves.toBeUndefined();
    expect(transcribeFirstAudio).not.toHaveBeenCalled();
  });
});
