import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { handleCronMigration } from "./cron-migration.js";

const capture = vi.hoisted(() => ({
  authority: vi.fn(),
  source: vi.fn(),
}));
vi.mock("../operator-run-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../operator-run-authority.js")>()),
  prepareGatewayOperatorRunAuthority: capture.authority,
}));
vi.mock("../../agents/operator-run-recovery-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/operator-run-recovery-source.js")>()),
  captureScheduledOperatorSource: capture.source,
}));
vi.mock("../config-revision-token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-revision-token.js")>()),
  loadGatewayConfigRevisionProjector: async () => ({
    projectRawHash: (hash: string) => hash,
    projectResolvedHash: (hash: string) => hash,
    hashResponseSessionBearer: (bearer: string) => bearer,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  capture.authority.mockReset();
  capture.source.mockReset();
});

it.each(["hold", "checkpoint"])(
  "admits scheduler %s only with live operator authority and an exact scope",
  async (phase) => {
    expect(resolveCoreOperatorGatewayMethodScope("cron.migration")).toBe("operator.admin");
    await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
      const context = expectDefined(
        getPluginRuntimeGatewayRequestScope()?.context,
        "local context",
      );
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
        params: { phase, operationId: "move", agentIds: ["alpha"] },
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
      await handler({ ...options, params: { phase, operationId: "move" } });
      expect(migrate).not.toHaveBeenCalled();
    });
  },
);

it.each([
  { name: "retain flag on activate", params: { phase: "activate", retainNonportable: true } },
  {
    name: "non-boolean retain flag",
    params: { phase: "hold", agentIds: ["alpha"], retainNonportable: "yes" },
  },
  {
    name: "target requester on a strict export",
    params: { phase: "export", targetRequesterProfileId: "gateway-owner" },
  },
  {
    name: "target requester on stage",
    params: { phase: "stage", agentIds: ["alpha"], targetRequesterProfileId: "gateway-owner" },
  },
  {
    name: "caller-supplied source rebinding",
    params: {
      phase: "stage",
      agentIds: ["alpha"],
      snapshot: snapshot(),
      rebindOperatorSources: { "job-a": gatewaySource("caller-device") },
    },
  },
  {
    name: "snapshot with an unknown field",
    params: { phase: "stage", agentIds: ["alpha"], snapshot: { ...snapshot(), extra: 1 } },
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

it("reports the authenticated staging requester without mutating the scheduler", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "local context");
    const migrate = vi.spyOn(context.cron, "migration");
    const source = gatewaySource("target-device").source;
    const release = vi.fn();
    const assertCurrent = vi.fn();
    capture.authority.mockResolvedValue({
      authority: { scopes: ["operator.admin"], recoverySnapshot: source.snapshot, assertCurrent },
      release,
    });
    const respond = vi.fn();
    await handleCronMigration({
      req: { type: "req", id: "migration", method: "cron.migration" },
      params: { operationId: "move", phase: "stage-requester" },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        operationId: "move",
        phase: "stage-requester",
        agentIds: [],
        drained: true,
        stageRequesterProfileId: source.snapshot.profileId,
      },
      undefined,
    );
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(migrate).not.toHaveBeenCalled();
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

it("rebinds a staged gateway-sourced job to the staging caller's operator authority", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const release = grantCaller();
    const sourced = { ...storedJob(), operatorSource: gatewaySource("source-device") };
    const { migrate, respond, params } = await stage([sourced, { ...storedJob(), id: "job-b" }]);
    expect(capture.source).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "alpha", independent: true }),
    );
    expect(migrate).toHaveBeenCalledExactlyOnceWith(
      {
        ...params,
        rebindOperatorSources: {
          "job-a": { source: gatewaySource("target-device").source, executionRevision: "rev-1" },
        },
      },
      expect.any(Function),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ phase: "stage" }),
      undefined,
    );
  });
});

it("narrows the rebound source to the stored grant", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    grantCaller();
    const narrow = gatewaySource("source-device", {
      scopes: ["operator.cron"],
      controlUiAdmin: false,
    });
    const { migrate } = await stage([{ ...storedJob(), operatorSource: narrow }]);
    const rebound = migrate.mock.calls[0]?.[0].rebindOperatorSources?.["job-a"]?.source.snapshot;
    expect(rebound?.scopes).not.toContain("operator.admin");
    expect(rebound).toMatchObject({
      automationAdmin: false,
      controlUiAdmin: false,
      device: { deviceId: "target-device" },
    });
  });
});

it.each([
  {
    name: "the caller has no operator authority",
    arrange: () => capture.authority.mockResolvedValue(undefined),
    message: "operator authority",
  },
  {
    name: "the job belongs to another requester",
    arrange: () =>
      grantCaller(gatewaySource("target-device", { profileId: "someone-else" }).source),
    message: "another requester",
  },
  {
    name: "the source cannot be minted",
    arrange: () => {
      grantCaller();
      capture.source.mockImplementation(() => {
        throw new Error("no recovery snapshot");
      });
    },
    message: "no recovery snapshot",
  },
])("refuses to stage a gateway-sourced job when $name", async ({ arrange, message }) => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    arrange();
    const { migrate, respond } = await stage([
      { ...storedJob(), operatorSource: gatewaySource("source-device") },
    ]);
    expect(migrate).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
    const release = (await capture.authority.mock.results[0]?.value)?.release;
    if (release) {
      expect(release).toHaveBeenCalledOnce();
    }
  });
});

it("guards the staged commit with the rebinding operator's authority", async () => {
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
    const release = grantCaller(gatewaySource("target-device").source, () => {
      throw new Error("operator revoked");
    });
    const { respond } = await stage([
      { ...storedJob(), operatorSource: gatewaySource("source-device") },
    ]);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator revoked") }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});

function gatewaySource(
  deviceId: string,
  overrides: { profileId?: string; scopes?: string[]; controlUiAdmin?: boolean } = {},
) {
  return {
    source: {
      version: 1 as const,
      kind: "gateway" as const,
      agentId: "alpha",
      sourceRunId: `run-${deviceId}`,
      snapshot: {
        profileId: overrides.profileId ?? "gateway-owner",
        scopes: overrides.scopes ?? ["operator.admin"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "" as const,
          grantGeneration: "grant",
          role: "operator" as const,
          authMethod: "device-token" as const,
        },
        device: { deviceId, key: "a".repeat(64) },
        automationAdmin: true,
        controlUiAdmin: overrides.controlUiAdmin ?? true,
        localOperator: true,
        sourceIngress: "control-ui" as const,
      },
    },
    executionRevision: "rev-1",
  };
}
async function stage(jobs: unknown[]) {
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
  const params = {
    operationId: "move",
    phase: "stage",
    agentIds: ["alpha"],
    snapshot: { ...snapshot(), jobs },
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
  return { migrate, respond, params };
}
function grantCaller(fresh = gatewaySource("target-device").source, assertCurrent = () => {}) {
  const release = vi.fn();
  capture.authority.mockResolvedValue({
    authority: { scopes: ["operator.admin"], assertCurrent },
    release,
  });
  capture.source.mockReturnValue(fresh);
  return release;
}
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
