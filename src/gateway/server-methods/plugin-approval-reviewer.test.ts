import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { withPluginApprovalReviewerGuard } from "../../infra/plugin-approval-reviewer.js";
import {
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequestPayload,
} from "../../infra/plugin-approvals.js";
import type { PluginApprovalReviewerGuard } from "../../plugin-sdk/approval-runtime.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createApprovalHandlers } from "./approval.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: () => ({
    resolverId: "fixture:account",
    authorizes: () => true,
  }),
}));

function fixture(test: TestContext) {
  test.signal.throwIfAborted();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reviewer-"));
  const databaseOptions = { path: path.join(root, "state.sqlite") };
  openOpenClawStateDatabase(databaseOptions);
  const persistence = { runtimeEpoch: "reviewer-test", databaseOptions };
  const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence,
    resolveAllowedDecisions: resolvePluginApprovalRequestAllowedDecisions,
  });
  const execManager = new ExecApprovalManager({ persistence });
  test.onTestFinished(async () => {
    await manager.drain();
    await execManager.drain();
    closeOpenClawStateDatabaseByPath(databaseOptions.path);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = {
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getApprovalClientConnIds: () => new Set<string>(["owner"]),
    hasExecApprovalClients: () => true,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
  const handlers = {
    ...createApprovalHandlers({
      execApprovalManager: execManager,
      pluginApprovalManager: manager,
      databaseOptions,
    }),
    ...createPluginApprovalHandlers(manager),
  };
  return {
    manager,
    async request(this: void, guard: PluginApprovalReviewerGuard) {
      const method = "plugin.approval.request";
      const params = {
        title: "Install editor",
        description: "Shared computer",
        allowedDecisions: ["allow-once", "deny"],
        twoPhase: true,
        timeoutMs: 60_000,
      };
      const completion = withPluginApprovalReviewerGuard(guard, async () => {
        await handlers[method]!({
          req: { id: "request-1", type: "req", method, params },
          params,
          context,
          respond: vi.fn(),
          isWebchatConnect: () => false,
          client: {
            connId: "requester",
            connect: { client: { id: "test" }, scopes: ["operator.admin"] },
          } as unknown as GatewayRequestHandlerOptions["client"],
        });
      });
      await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
      return { record: manager.listPendingRecords()[0]!, completion };
    },
    async resolve(
      this: void,
      method: string,
      id: string,
      deviceId: string,
      scopes = ["operator.admin"],
      approvalRuntime = false,
      reviewer?: { channel: string; accountId: string; senderId: string },
    ) {
      const respond = vi.fn();
      const params = {
        id,
        decision: "allow-once",
        ...(method === "approval.resolve" ? { kind: "plugin" } : {}),
        ...(reviewer ? { reviewer } : {}),
      };
      await handlers[method]!({
        req: { id: "req-1", type: "req", method, params },
        params,
        context,
        respond,
        isWebchatConnect: () => false,
        client: {
          connId: deviceId,
          ...(approvalRuntime ? { internal: { approvalRuntime: true } } : {}),
          connect: { client: { id: "test" }, device: { id: deviceId }, scopes },
        } as unknown as GatewayRequestHandlerOptions["client"],
      });
      return respond;
    },
  };
}

describe.each(["approval.resolve", "plugin.approval.resolve"])(
  "%s reviewer authority",
  (method) => {
    it.for([
      { actor: "admin", scopes: ["operator.admin"], approvalRuntime: false },
      { actor: "approval runtime", scopes: ["operator.approvals"], approvalRuntime: true },
    ])(
      "does not let an $actor bypass the current owner's reviewer guard",
      async ({ scopes, approvalRuntime }, test) => {
        const { manager, resolve } = fixture(test);
        const controller = new AbortController();
        const prepare = vi.fn(async (reviewer: { deviceId?: string }) =>
          reviewer.deviceId === "owner" ? () => {} : null,
        );
        const record = Object.assign(
          manager.create(
            {
              title: "Install editor",
              description: "Install editor on shared computer",
              allowedDecisions: ["allow-once", "deny"],
            },
            60_000,
            "plugin:owner-only",
          ),
          {
            reviewerGuardRequired: true,
            reviewerGuard: { signal: controller.signal, assertActive() {}, prepare },
          },
        );
        void manager.register(record, 60_000);
        const denied = await resolve(method, record.id, "other-builder", scopes, approvalRuntime);
        expect(denied.mock.calls[0]?.[0]).toBe(false);
        expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
        expect(prepare).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: "other-builder", decision: "allow-once" }),
        );
        const allowed = await resolve(method, record.id, "owner", scopes, approvalRuntime);
        expect(allowed.mock.calls[0]?.[0]).toBe(true);
        expect(manager.getSnapshot(record.id)?.decision).toBe("allow-once");
      },
    );
  },
);

describe.each(["approval.resolve", "plugin.approval.resolve"])(
  "%s reviewer lifecycle",
  (method) => {
    it("does not treat an ordinary client's claimed channel reviewer as authenticated identity", async (test) => {
      const { manager, resolve } = fixture(test);
      const prepare = vi.fn(async (reviewer: { channel?: { senderId: string } }) =>
        reviewer.channel?.senderId === "channel-owner" ? () => {} : null,
      );
      const record = Object.assign(
        manager.create(
          { title: "Install editor", description: "Shared computer" },
          60_000,
          "plugin:channel-reviewer",
        ),
        {
          reviewerGuardRequired: true,
          reviewerGuard: { signal: new AbortController().signal, assertActive() {}, prepare },
        },
      );
      void manager.register(record, 60_000);
      const reviewer = { channel: "fixture", accountId: "account", senderId: "channel-owner" };
      const denied = await resolve(
        method,
        record.id,
        "other-builder",
        ["operator.admin"],
        false,
        reviewer,
      );
      expect(denied.mock.calls[0]?.[0]).toBe(false);
      expect(prepare).toHaveBeenLastCalledWith({
        deviceId: "other-builder",
        decision: "allow-once",
      });
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
      const allowed = await resolve(
        method,
        record.id,
        "channel-runtime",
        ["operator.approvals"],
        true,
        reviewer,
      );
      expect(allowed.mock.calls[0]?.[0]).toBe(true);
      expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ channel: reviewer }));
    });

    it("rechecks owner authority after awaiting reviewer preparation", async (test) => {
      const { manager, resolve } = fixture(test);
      let currentOwner = "owner";
      let release!: () => void;
      const waiting = new Promise<void>((done) => {
        release = done;
      });
      const prepare = vi.fn(async (reviewer: { deviceId?: string }) => {
        await waiting;
        return () => {
          if (reviewer.deviceId !== currentOwner) {
            throw new Error("owner changed");
          }
        };
      });
      const record = Object.assign(
        manager.create(
          { title: "Install editor", description: "Shared computer" },
          60_000,
          "plugin:owner-race",
        ),
        {
          reviewerGuardRequired: true,
          reviewerGuard: { signal: new AbortController().signal, assertActive() {}, prepare },
        },
      );
      void manager.register(record, 60_000);
      const resolving = resolve(method, record.id, "owner");
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      currentOwner = "new-owner";
      release();
      const response = await resolving;
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
      expect(manager.resolve(record.id, "allow-once", "unchecked-runtime")).toBe(false);
    });

    it("rechecks native resolver access after awaiting reviewer preparation", async (test) => {
      const { manager, resolve } = fixture(test);
      const scopes = ["operator.admin"];
      const record = Object.assign(
        manager.create(
          { title: "Install editor", description: "Shared computer" },
          60_000,
          "plugin:revoked-reviewer",
        ),
        {
          reviewerGuardRequired: true,
          reviewerGuard: {
            signal: new AbortController().signal,
            assertActive() {},
            async prepare() {
              scopes.length = 0;
              return () => {};
            },
          },
        },
      );
      void manager.register(record, 60_000);
      const response = await resolve(method, record.id, "owner", scopes);
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    });

    it("fails closed when a required reviewer guard is missing", async (test) => {
      const { manager, resolve } = fixture(test);
      const record = Object.assign(
        manager.create(
          { title: "Install editor", description: "Shared computer" },
          60_000,
          "plugin:lost-guard",
        ),
        { reviewerGuardRequired: true },
      );
      void manager.register(record, 60_000);
      const response = await resolve(method, record.id, "owner");
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    });

    it("fails closed when the owner lifetime ends during reviewer preparation", async (test) => {
      const { manager, resolve } = fixture(test);
      const controller = new AbortController();
      const record = Object.assign(
        manager.create(
          { title: "Install editor", description: "Shared computer" },
          60_000,
          "plugin:closed-owner",
        ),
        {
          reviewerGuardRequired: true,
          reviewerGuard: {
            signal: controller.signal,
            assertActive() {},
            async prepare() {
              controller.abort();
              return () => {};
            },
          },
        },
      );
      void manager.register(record, 60_000);
      const response = await resolve(method, record.id, "owner");
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    });
  },
);

describe("in-process plugin approval reviewer request", () => {
  it("captures the SDK guard on the real request and requires it at resolution", async (test) => {
    const { manager, request, resolve } = fixture(test);
    const controller = new AbortController();
    const prepare = vi.fn(async (reviewer: { deviceId?: string }) =>
      reviewer.deviceId === "owner" ? () => {} : null,
    );
    const { record, completion } = await request({
      signal: controller.signal,
      assertActive() {},
      prepare,
    });
    expect(record.reviewerGuardRequired).toBe(true);
    expect(record.request).not.toHaveProperty("reviewerGuard");
    expect((await resolve("approval.resolve", record.id, "other-builder")).mock.calls[0]?.[0]).toBe(
      false,
    );
    expect(manager.getSnapshot(record.id)?.decision).toBeUndefined();
    expect((await resolve("plugin.approval.resolve", record.id, "owner")).mock.calls[0]?.[0]).toBe(
      true,
    );
    await completion;
  });

  it("requires an in-process request and rejects expired owner authority", async () => {
    const controller = new AbortController();
    const guard = { signal: controller.signal, assertActive() {}, prepare: async () => () => {} };
    await expect(
      withPluginApprovalReviewerGuard(guard, async () => "remote-result"),
    ).rejects.toThrow("one in-process Gateway request");
    controller.abort(new Error("owner closed"));
    await expect(withPluginApprovalReviewerGuard(guard, async () => "result")).rejects.toThrow(
      "owner closed",
    );
  });
});
