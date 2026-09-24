import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { cronHandlers } from "./cron.js";

afterEach(() => vi.restoreAllMocks());

it("registers scheduler migration as admin-only and carries live caller authority to the owner", async () => {
  expect(resolveCoreOperatorGatewayMethodScope("cron.migration")).toBe("operator.admin");
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local context");
    const migrate = vi
      .spyOn(context.cron, "migration")
      .mockImplementation(async (request, assertCurrent) => {
        assertCurrent?.();
        return {
          operationId: request.operationId,
          phase: request.phase,
          agentIds: ["alpha"],
          drained: true,
        };
      });
    const respond = vi.fn();
    const handler = expectDefined(cronHandlers["cron.migration"], "migration handler");
    const options = {
      req: { type: "req" as const, id: "migration", method: "cron.migration" },
      params: { phase: "hold", operationId: "move", agentIds: ["alpha"] },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
    };
    await handler({ ...options, hasCurrentClientAuthority: () => true });
    expect(migrate).toHaveBeenCalledExactlyOnceWith(options.params, expect.any(Function));
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ drained: true }),
      undefined,
    );
    migrate.mockClear();
    respond.mockClear();
    await handler({ ...options, hasCurrentClientAuthority: () => false });
    expect(migrate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("expired") }),
    );
    await handler({ ...options, params: { phase: "hold", operationId: "move" } });
    expect(migrate).not.toHaveBeenCalled();
  });
});
