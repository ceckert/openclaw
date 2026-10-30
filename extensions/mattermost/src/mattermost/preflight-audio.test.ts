import { describe, expect, it, vi } from "vitest";
import type { MattermostMediaInfo } from "./monitor-resources.js";
import { createMattermostPreflightAudio } from "./preflight-audio.js";

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
  it("transcribes the first downloaded audio attachment for mention admission", async () => {
    const transcribeFirstAudio = vi.fn(async () => "hey octo");
    const preflight = createMattermostPreflightAudio({ transcribeFirstAudio });
    await expect(preflight.resolveTranscript({ ...request, media: [image, voice] })).resolves.toBe(
      "hey octo",
    );
    expect(transcribeFirstAudio).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          media: [{ path: "/tmp/v.ogg", contentType: "audio/ogg; codecs=opus" }],
          Provider: "mattermost",
          OriginatingTo: "channel:chan-1",
        }),
      }),
    );
  });

  it.each([
    { label: "audio that failed to download", media: [{ ...voice, path: undefined }] },
    { label: "non-audio attachments", media: [image] },
  ])("skips $label", async ({ media }) => {
    const transcribeFirstAudio = vi.fn(async () => "never");
    const preflight = createMattermostPreflightAudio({ transcribeFirstAudio });
    await expect(preflight.resolveTranscript({ ...request, media })).resolves.toBeUndefined();
    expect(transcribeFirstAudio).not.toHaveBeenCalled();
  });
});
