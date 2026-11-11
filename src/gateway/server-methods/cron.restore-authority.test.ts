import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronJobSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import { loadCronStore } from "../../cron/store.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { callCron, createHistoryJob, createReadService } from "./cron-read.test-support.js";
import { cronAccountPolicy, createCronCallerClient } from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

// Credential capture is exercised by cron.inference-binding.test.ts; these fixtures have no account.
vi.mock("../../cron/inference-binding.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/inference-binding.runtime.js")>()),
  captureCronInferenceBinding: async () => undefined,
}));

const sessionKey = "agent:main:discord:direct:owner-1";
const accountId = "work";
const cfg: OpenClawConfig = {};
const accountPolicy = cronAccountPolicy(sessionKey, accountId);
const provenance = {
  version: 1,
  source: "authenticated-requester",
  callerOrigin: { kind: "external", channel: "discord" },
  channelRequester: { version: 1, channel: "discord", accountId, senderId: "owner-1" },
} as const;
const restored = { scheduledToolPolicy: accountPolicy, toolsAllowProvenance: provenance };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string | undefined;
let cron: CronService | undefined;

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-cron-restore-authority-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot(cfg);
});

afterEach(async () => {
  cron?.stop();
  cron = undefined;
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
  }
  stateDir = undefined;
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createFixture() {
  const storePath = path.join(expectDefined(stateDir, "test state"), "cron", "jobs.json");
  cron = createReadService({
    storePath,
    cronEnabled: false,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  const context = createDirectChatContext({
    cron,
    cronStorePath: storePath,
    getRuntimeConfig: () => cfg,
  });
  const operator = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  const agent = () => createCronCallerClient("main", accountId, sessionKey);
  const add = (fields: Record<string, unknown>, client: GatewayClient = operator) =>
    callCron(
      context,
      "cron.add",
      {
        ...createHistoryJob("main", sessionKey, "Restored automation"),
        owner: { agentId: "main", sessionKey, accountId },
        payload: { kind: "agentTurn", message: "Check status", toolsAllow: ["message"] },
        ...fields,
      },
      { client },
    );
  const storedJobs = async () => (await loadCronStore(storePath)).jobs;
  return { context, operator, agent, add, storedJobs };
}

function expectInvalidRequest(respond: Awaited<ReturnType<typeof callCron>>, message?: string) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      ...(message ? { message: expect.stringContaining(message) } : {}),
    }),
  );
}

describe("cron restore authority", () => {
  it("stores an operator-supplied account policy and provenance verbatim", async () => {
    const { add, storedJobs } = createFixture();
    const respond = await add(restored);
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
    const [job] = await storedJobs();
    expect(job?.scheduledToolPolicy).toEqual(accountPolicy);
    expect(job?.toolsAllowProvenance).toEqual(provenance);
  });

  it("keeps the trusted policy for an operator add without restore fields", async () => {
    const { add, storedJobs } = createFixture();
    const respond = await add({});
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
    const [job] = await storedJobs();
    expect(job?.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
    expect(job?.toolsAllowProvenance).toBeUndefined();
  });

  it.each([
    ["scheduledToolPolicy", { scheduledToolPolicy: accountPolicy }],
    ["toolsAllowProvenance", { toolsAllowProvenance: provenance }],
  ] as const)("rejects an agent-runtime add that supplies %s", async (_field, fields) => {
    const { add, agent, storedJobs } = createFixture();
    expectInvalidRequest(await add(fields, agent()), "operator");
    expect(await storedJobs()).toEqual([]);
  });

  it.each([
    [
      "policy without an account",
      { scheduledToolPolicy: { ...accountPolicy, ownerAccountId: "" } },
    ],
    ["policy of a future version", { scheduledToolPolicy: { version: 2, mode: "trusted" } }],
    ["policy for another owner", { scheduledToolPolicy: cronAccountPolicy("agent:main:other") }],
    ["provenance of an unknown source", { toolsAllowProvenance: { ...provenance, source: "x" } }],
    ["provenance with extra fields", { toolsAllowProvenance: { ...provenance, extra: true } }],
    [
      "provenance without an origin or requester",
      { toolsAllowProvenance: { version: 1, source: "authenticated-requester" } },
    ],
    [
      "provenance with an unusable requester account",
      {
        toolsAllowProvenance: {
          ...provenance,
          channelRequester: { ...provenance.channelRequester, accountId: "__proto__" },
        },
      },
    ],
  ] as const)("rejects an operator add with a %s", async (_case, fields) => {
    const { add, storedJobs } = createFixture();
    expectInvalidRequest(await add({ ...restored, ...fields }));
    expect(await storedJobs()).toEqual([]);
  });

  it("returns recorded provenance to operators only", async () => {
    const { add, context, operator, agent } = createFixture();
    const created = await add(restored);
    const { id } = expectDefined(created.mock.calls[0], "add response")[1] as { id: string };
    const read = async (method: "cron.list" | "cron.get", client: GatewayClient) => {
      const respond = await callCron(
        context,
        method,
        method === "cron.list" ? { includeDisabled: true, includeDeliveryPreviews: false } : { id },
        { client },
      );
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
      const result = expectDefined(respond.mock.calls[0], "read response")[1] as {
        jobs?: unknown[];
      };
      return (method === "cron.list" ? result.jobs?.[0] : result) as Record<string, unknown>;
    };
    for (const method of ["cron.list", "cron.get"] as const) {
      const { effectiveAgentId: _effectiveAgentId, ...operatorJob } = await read(method, operator);
      expect(operatorJob).toMatchObject({ id, ...restored });
      expect(Value.Errors(CronJobSchema, operatorJob)).toEqual([]);
      const agentJob = await read(method, agent());
      expect(agentJob).toMatchObject({ id, scheduledToolPolicy: accountPolicy });
      expect(agentJob).not.toHaveProperty("toolsAllowProvenance");
    }
  });
});
