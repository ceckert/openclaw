import { describe, expect, it } from "vitest";
import {
  copyAgentRunObservationContext,
  createScheduledRunObservation,
} from "./agent-run-observation-context.js";

describe("createScheduledRunObservation", () => {
  it.each([
    {
      name: "a resolved chat delivery",
      params: {
        invocationId: "invocation-1",
        deliveryMode: "announce" as const,
        resolvedDeliveryOk: true,
        resolvedDelivery: {
          channel: "mattermost",
          to: "channel-1",
          accountId: "account-1",
          threadId: "thread-1",
        },
      },
      expected: {
        invocationId: "invocation-1",
        delivery: {
          kind: "chat",
          channel: "mattermost",
          to: "channel-1",
          accountId: "account-1",
          threadId: "thread-1",
        },
      },
    },
    {
      name: "disabled delivery",
      params: {
        invocationId: "invocation-2",
        deliveryMode: "none" as const,
        resolvedDeliveryOk: false,
        resolvedDelivery: {},
      },
      expected: { invocationId: "invocation-2", delivery: { kind: "none" } },
    },
    {
      name: "webhook delivery",
      params: {
        invocationId: "invocation-3",
        deliveryMode: "webhook" as const,
        resolvedDeliveryOk: false,
        resolvedDelivery: {},
      },
      expected: { invocationId: "invocation-3", delivery: { kind: "webhook" } },
    },
    {
      name: "an invalid chat delivery",
      params: {
        invocationId: "invocation-4",
        deliveryMode: "announce" as const,
        resolvedDeliveryOk: false,
        resolvedDelivery: { channel: "mattermost", accountId: "account-1" },
      },
      expected: {
        invocationId: "invocation-4",
        delivery: { kind: "invalid", channel: "mattermost", accountId: "account-1" },
      },
    },
  ])("records $name without inferring a session target", ({ params, expected }) => {
    expect(createScheduledRunObservation(params)).toEqual(expected);
  });

  it("returns a frozen deep copy to observers", () => {
    const observation = copyAgentRunObservationContext({
      origin: "scheduled",
      scheduled: createScheduledRunObservation({
        invocationId: "invocation-5",
        deliveryMode: "announce",
        resolvedDeliveryOk: true,
        resolvedDelivery: { channel: "mattermost", to: "channel-1" },
      }),
    });

    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.scheduled)).toBe(true);
    expect(Object.isFrozen(observation.scheduled?.delivery)).toBe(true);
  });
});
