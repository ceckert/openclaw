/**
 * Tests for gateway secret resolution and redacted secret method responses.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

// Handler tests only need the registry verdicts they exercise. Dedicated
// target-registry tests own bundled plugin discovery and compilation. The
// remaining exports stay real so secrets.apply plan validation resolves
// targets through the actual registry.
vi.mock("../../secrets/target-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/target-registry.js")>();
  return {
    ...actual,
    isKnownCoreSecretTargetId: (value: unknown) => value === "talk.providers.*.apiKey",
    isKnownSecretTargetId: () => false,
  };
});

import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../../test-utils/talk-test-provider.js";
import { createSecretsHandlers } from "./secrets.js";

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await expectDefined(
    params.handlers["secrets.reload"],
    'params.handlers["secrets.reload"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeSecretsResolve(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
  commandName: unknown;
  targetIds: unknown;
  allowedPaths?: unknown;
  forcedActivePaths?: unknown;
}) {
  await expectDefined(
    params.handlers["secrets.resolve"],
    'params.handlers["secrets.resolve"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.resolve" },
    params: {
      commandName: params.commandName,
      targetIds: params.targetIds,
      ...(params.allowedPaths !== undefined ? { allowedPaths: params.allowedPaths } : {}),
      ...(params.forcedActivePaths !== undefined
        ? { forcedActivePaths: params.forcedActivePaths }
        : {}),
    },
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.resolve"]
    >[0]["respond"],
    context: {} as never,
  });
}

function expectRespondError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code: string; message?: string },
): void {
  const call = respond.mock.calls.at(0);
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  const error = call?.[2];
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("Expected a non-array error record");
  }
  const errorRecord = error as Record<string, unknown>;
  expect(errorRecord.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(errorRecord.message).toBe(expected.message);
  }
}

function expectWarnMessageWith(warn: ReturnType<typeof vi.fn>, text: string): void {
  expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

async function expectMemoryStatusResolveUnavailable(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  warn: ReturnType<typeof vi.fn>;
  warningText: string;
}) {
  const respond = vi.fn();
  await invokeSecretsResolve({
    handlers: params.handlers,
    respond,
    commandName: "memory status",
    targetIds: ["talk.providers.*.apiKey"],
  });
  expectRespondError(respond, {
    code: "UNAVAILABLE",
    message: "secrets.resolve failed",
  });
  expectWarnMessageWith(params.warn, params.warningText);
}

describe("secrets handlers", () => {
  function createHandlers(overrides?: {
    reloadSecrets?: () => Promise<{ warningCount: number }>;
    applySecrets?: Parameters<typeof createSecretsHandlers>[0]["applySecrets"];
    resolveSecrets?: (params: {
      commandName: string;
      targetIds: string[];
      allowedPaths?: string[];
      forcedActivePaths?: string[];
    }) => Promise<{
      assignments: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      diagnostics: string[];
      inactiveRefPaths: string[];
    }>;
    log?: { warn?: (message: string) => void };
  }) {
    const reloadSecrets = overrides?.reloadSecrets ?? (async () => ({ warningCount: 0 }));
    const applySecrets =
      overrides?.applySecrets ??
      (async () => ({ mode: "write", changed: false, changedFiles: [] }) as never);
    const resolveSecrets =
      overrides?.resolveSecrets ??
      (async () => ({
        assignments: [],
        diagnostics: [],
        inactiveRefPaths: [],
      }));
    return createSecretsHandlers({
      reloadSecrets,
      applySecrets,
      resolveSecrets,
      log: overrides?.log,
    });
  }

  const validApplyPlan = {
    version: 1,
    protocolVersion: 1,
    generatedAt: "2026-08-07T00:00:00.000Z",
    generatedBy: "manual",
    targets: [
      {
        type: "auth-profiles.api_key.key",
        path: "profiles.platform-openrouter.key",
        ref: { source: "exec", provider: "gcp-secret-manager", id: "octogee/model-key" },
        agentId: "octogee-test-coach",
        authProfileProvider: "openrouter",
      },
    ],
  };

  async function invokeSecretsApply(params: {
    handlers: ReturnType<typeof createSecretsHandlers>;
    respond: ReturnType<typeof vi.fn>;
    requestParams: unknown;
  }) {
    await expectDefined(
      params.handlers["secrets.apply"],
      'params.handlers["secrets.apply"] test invariant',
    )({
      req: { type: "req", id: "1", method: "secrets.apply" },
      params: params.requestParams,
      client: null,
      isWebchatConnect: () => false,
      respond: params.respond as unknown as Parameters<
        ReturnType<typeof createSecretsHandlers>["secrets.apply"]
      >[0]["respond"],
      context: {} as never,
    });
  }

  it("applies a valid plan in write mode by default", async () => {
    const applySecrets = vi.fn().mockResolvedValue({
      mode: "write",
      changed: true,
      changedFiles: ["auth-profiles.json"],
    });
    const handlers = createHandlers({ applySecrets });
    const respond = vi.fn();
    await invokeSecretsApply({
      handlers,
      respond,
      requestParams: { plan: validApplyPlan, allowExec: true },
    });
    expect(applySecrets).toHaveBeenCalledWith({
      plan: validApplyPlan,
      write: true,
      allowExec: true,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      mode: "write",
      changed: true,
      changedFiles: ["auth-profiles.json"],
    });
  });

  it("passes dryRun through as write=false", async () => {
    const applySecrets = vi.fn().mockResolvedValue({ mode: "dry-run", changed: false });
    const handlers = createHandlers({ applySecrets });
    const respond = vi.fn();
    await invokeSecretsApply({
      handlers,
      respond,
      requestParams: { plan: validApplyPlan, dryRun: true },
    });
    expect(applySecrets).toHaveBeenCalledWith({
      plan: validApplyPlan,
      write: false,
      allowExec: false,
    });
  });

  it("rejects a malformed plan without invoking the engine", async () => {
    const applySecrets = vi.fn();
    const handlers = createHandlers({ applySecrets });
    const respond = vi.fn();
    await invokeSecretsApply({
      handlers,
      respond,
      requestParams: { plan: { version: 2, targets: "nope" } },
    });
    expect(applySecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.apply params: plan",
    });
  });

  it("surfaces engine failures with their caller-actionable message", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      applySecrets: vi
        .fn()
        .mockRejectedValue(
          new Error("Plan contains exec SecretRefs/providers. Re-run with --allow-exec."),
        ),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsApply({
      handlers,
      respond,
      requestParams: { plan: validApplyPlan },
    });
    expectRespondError(respond, { code: "UNAVAILABLE" });
    const error = respond.mock.calls[0]?.[2] as { message?: string };
    expect(error.message).toContain("--allow-exec");
  });

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("disk full")),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.reload failed",
    });
    expectWarnMessageWith(warn, "disk full");
  });

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
  });

  it("rejects invalid secrets.resolve params", async () => {
    const handlers = createHandlers();
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "",
      targetIds: "bad",
    });
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.resolve params: targetIds",
    });
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
    });
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const warn = vi.fn();
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: TALK_TEST_PROVIDER_API_KEY_PATH, pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets, log: { warn } });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "secrets.resolve returned invalid payload.",
    });
  });

  it("logs error details when secrets.resolve throws", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      resolveSecrets: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      log: { warn },
    });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "EACCES: permission denied",
    });
  });
});
