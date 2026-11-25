import { expect, it } from "vitest";
import { outboundDeliveryAgentIds } from "./delivery-queue-agent.js";

const destination = { channel: "matrix", to: "!synthetic:example" };

it("retains every explicit completion, execution and mirror dependency", () => {
  expect(
    outboundDeliveryAgentIds({
      ...destination,
      session: { agentId: "executor" },
      mirror: { agentId: "mirror", sessionKey: "agent:mirror:main" },
      deliveryCompletion: { kind: "conversation", agentId: "requester", operationId: "intent" },
    }),
  ).toEqual(["requester", "executor", "mirror"]);
});

it("uses only the explicit canonical locator for an older pending-final completion", () => {
  const completion = {
    kind: "pending-final" as const,
    deliveryId: "final-delivery",
    intentId: "final-intent",
    sessionId: "final-session",
    sessionKey: "agent:traveler:matrix:direct:recipient",
    storePath: "/synthetic/sessions.json",
  };
  expect(outboundDeliveryAgentIds({ ...destination, deliveryCompletion: completion })).toEqual([
    "traveler",
  ]);
  expect(
    outboundDeliveryAgentIds({
      ...destination,
      deliveryCompletion: { ...completion, sessionKey: "main" },
    }),
  ).toEqual([]);
});

it("does not manufacture an agent from an account, destination or destination policy key", () => {
  expect(
    outboundDeliveryAgentIds({
      ...destination,
      accountId: "traveler",
      session: { policyKey: "agent:traveler:main" },
    }),
  ).toEqual([]);
});
