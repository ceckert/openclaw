import { describe, expect, it, vi } from "vitest";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

describe("gateway aux handler routes", () => {
  it("routes a lazy handler for every advertised aux method", () => {
    const { extraHandlers } = createGatewayAuxHandlers({
      log: {},
      activateRuntimeSecrets: async () => {
        throw new Error("route inventory must not activate runtime secrets");
      },
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      channelManager: {
        startChannel: vi.fn(),
        stopChannel: vi.fn(),
        isManuallyStopped: () => false,
        resolveRuntimeAccountId: (_channel, accountId) => accountId,
      },
      logChannels: { info: vi.fn() },
    });

    for (const method of GATEWAY_AUX_METHODS) {
      expect(extraHandlers[method], `missing routed handler for ${method}`).toBeTypeOf("function");
    }
  });
});
