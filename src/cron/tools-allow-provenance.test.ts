import { describe, expect, it } from "vitest";
import { resolveCronScheduledRequester } from "./tools-allow-provenance.js";
import type { CronStoredJob } from "./types.js";

const requester = {
  version: 1 as const,
  channel: "mattermost",
  accountId: "acme-coach",
  senderId: "owner-sender",
};

function job(
  overrides: Partial<
    Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">
  > = {},
) {
  return {
    payload: { kind: "agentTurn", message: "brief me", toolsAllow: ["*"] },
    owner: { sessionKey: "agent:coach:mattermost:direct:owner-sender", accountId: "acme-coach" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:coach:mattermost:direct:owner-sender",
      ownerAccountId: "acme-coach",
    },
    toolsAllowProvenance: {
      version: 1,
      source: "authenticated-requester",
      channelRequester: requester,
    },
    ...overrides,
  } as Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">;
}

const delivery = {
  ok: true,
  channel: "mattermost",
  to: "user:owner-sender",
  accountId: "acme-coach",
};

describe("resolveCronScheduledRequester", () => {
  it("exposes the job creator with the run's delivery route", () => {
    expect(resolveCronScheduledRequester(job(), delivery)).toStrictEqual({
      channel: "mattermost",
      accountId: "acme-coach",
      senderId: "owner-sender",
      to: "user:owner-sender",
    });
  });

  it.each([
    ["a failed delivery resolution", { ...delivery, ok: false }],
    ["a route without a target", { ...delivery, to: " " }],
    ["another channel", { ...delivery, channel: "slack" }],
    ["another account", { ...delivery, accountId: "other-coach" }],
  ])("withholds the creator for %s", (_label, route) => {
    expect(resolveCronScheduledRequester(job(), route)).toBeUndefined();
  });

  it("withholds jobs without an authenticated creator", () => {
    expect(
      resolveCronScheduledRequester(job({ toolsAllowProvenance: undefined }), delivery),
    ).toBeUndefined();
  });

  it("withholds trusted-policy jobs even when provenance names a sender", () => {
    expect(
      resolveCronScheduledRequester(
        job({ scheduledToolPolicy: { version: 1, mode: "trusted" } }),
        delivery,
      ),
    ).toBeUndefined();
  });

  it("withholds a creator whose account is not the job owner's", () => {
    expect(
      resolveCronScheduledRequester(
        job({
          toolsAllowProvenance: {
            version: 1,
            source: "authenticated-requester",
            channelRequester: { ...requester, accountId: "other-coach" },
          },
        }),
        { ...delivery, accountId: "other-coach" },
      ),
    ).toBeUndefined();
  });
});
