import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

/** Ack/status reactions and audio preflight admission against the shared inbound harness. */
export function registerMattermostFeedbackTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (
    config: OpenClawConfig,
    route?: undefined,
    options?: { mentionRegexes?: RegExp[] },
  ) => unknown;
  receivePost: (
    post: { id: string; message: string; fileIds?: string[] },
    config?: OpenClawConfig,
  ) => Promise<{ WasMentioned?: boolean } | undefined>;
  mockState: {
    abortController: AbortController | undefined;
    createMattermostClient: Mock;
    dispatchInboundMessage: Mock;
    resolveMattermostMedia: Mock;
    resolvePreflightAudioTranscript: Mock;
  };
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState } = harness;

  it("acks the post and cycles status reactions through the run", async () => {
    const request = vi.fn(async () => ({}));
    mockState.createMattermostClient.mockReturnValue({ request });
    const config = { ...testConfig, messages: { ackReactionScope: "all" as const } };
    createRuntimeCore(config);
    mockState.dispatchInboundMessage.mockImplementation(async ({ replyOptions: reply }) => {
      reply?.onAssistantMessageStart?.();
      await reply?.onToolStart?.({ toolCallId: "exec-1", name: "exec", phase: "start" });
      mockState.abortController?.abort();
    });
    await receivePost({ id: "post-ack", message: "hello" }, config);
    const reactions = () =>
      request.mock.calls.map(
        ([requestPath, init]: [string, { method?: string; body?: string } | undefined]) =>
          `${init?.method ?? "GET"} ${requestPath} ${init?.body ?? ""}`,
      );
    // Acknowledgement presentation keeps the single ack emoji through thinking and
    // tool phases; only a failed run would replace it.
    expect(reactions()).toEqual([
      'POST /reactions {"user_id":"bot-user","post_id":"post-ack","emoji_name":"eyes"}',
    ]);
  });

  it.each([
    { transcript: "hey octo, deploy please", dispatched: true },
    { transcript: undefined, dispatched: false },
  ])(
    "admits a media-only voice post only by spoken mention (transcript=$transcript)",
    async ({ transcript, dispatched }) => {
      const config = {
        channels: {
          mattermost: { ...testConfig.channels?.mattermost, chatmode: "oncall" as const },
        },
      };
      createRuntimeCore(config, undefined, { mentionRegexes: [/\bocto\b/i] });
      const media = [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }];
      mockState.resolveMattermostMedia.mockResolvedValue(media);
      mockState.resolvePreflightAudioTranscript.mockResolvedValue(transcript);
      const ctx = await receivePost(
        { id: "post-voice", message: "", fileIds: ["voice-1"] },
        config,
      );
      expect(mockState.resolvePreflightAudioTranscript).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ media, accountId: "default", originatingTo: "channel:chan-1" }),
      );
      expect(mockState.resolveMattermostMedia).toHaveBeenCalledTimes(1);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      if (dispatched) {
        expect(ctx?.WasMentioned).toBe(true);
      }
    },
  );
}
