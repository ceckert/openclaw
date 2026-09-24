import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { handleCronMigration } from "./cron-migration.js";

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
    const handler = handleCronMigration;
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

it.each([
  { name: "retain flag on activate", params: { phase: "activate", retainNonportable: true } },
  {
    name: "non-boolean retain flag",
    params: { phase: "hold", agentIds: ["alpha"], retainNonportable: "yes" },
  },
  {
    name: "snapshot with an unknown field",
    params: { phase: "stage", agentIds: ["alpha"], snapshot: { ...snapshot(), extra: 1 } },
  },
  {
    name: "snapshot job without a schedule",
    params: {
      phase: "stage",
      agentIds: ["alpha"],
      snapshot: { ...snapshot(), jobs: [{ ...storedJob(), schedule: undefined }] },
    },
  },
  {
    name: "snapshot scratch for a foreign job",
    params: {
      phase: "stage",
      agentIds: ["alpha"],
      snapshot: { ...snapshot(), scratch: [scratch("other")] },
    },
  },
  {
    name: "retained IDs overlapping snapshot jobs",
    params: {
      phase: "stage",
      agentIds: ["alpha"],
      snapshot: { ...snapshot(), retainedJobIds: ["job-a"] },
    },
  },
])("rejects a migration request with $name before reaching the scheduler", async ({ params }) => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local context");
    const migrate = vi.spyOn(context.cron, "migration");
    const respond = vi.fn();
    await handleCronMigration({
      req: { type: "req" as const, id: "migration", method: "cron.migration" },
      params: { operationId: "move", ...params },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => true,
    });
    expect(migrate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("Invalid cron migration") }),
    );
  });
});

it("passes a validated partial-handoff stage request to the scheduler", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local context");
    const migrate = vi.spyOn(context.cron, "migration").mockResolvedValue({
      operationId: "move",
      phase: "stage",
      agentIds: ["alpha"],
      drained: true,
    });
    const respond = vi.fn();
    const params = {
      operationId: "move",
      phase: "stage",
      agentIds: ["alpha"],
      retainNonportable: true,
      snapshot: { ...snapshot(), scratch: [scratch("job-a")], retainedJobIds: ["job-x"] },
    };
    await handleCronMigration({
      req: { type: "req" as const, id: "migration", method: "cron.migration" },
      params,
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => true,
    });
    expect(migrate).toHaveBeenCalledExactlyOnceWith(params, expect.any(Function));
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ phase: "stage" }),
      undefined,
    );
  });
});

function storedJob() {
  return {
    id: "job-a",
    agentId: "alpha",
    name: "job-a",
    enabled: true,
    createdAtMs: 10,
    updatedAtMs: 20,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the weather" },
    state: { nextRunAtMs: 60123 },
  };
}
function scratch(jobId: string) {
  return { jobId, content: "notes", revision: 1, sourceSha256: null, updatedAtMs: 5 };
}
function snapshot() {
  return { version: 1, operationId: "move", agentIds: ["alpha"], jobs: [storedJob()], scratch: [] };
}
