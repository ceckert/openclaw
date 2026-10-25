import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import {
  deliverFinal,
  persistMarker,
  recoveryFor,
} from "../../agents/command/delivery.test-support.js";
import { createCliProcessFixture } from "../../cli/isolated-process-fixture.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { installDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../../infra/database-engine/registry.js";
import * as queueAdmission from "../../infra/outbound/deliver-queue-admission.js";
import {
  OutboundDeliveryAdmissionClosedError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import {
  installQueueTestPlugin,
  matrixDeliveryResult,
  useOutboundRuntime,
} from "../../infra/outbound/deliver.custody.test-support.js";
import { ackDelivery } from "../../infra/outbound/delivery-queue-ack.js";
import * as mediaStaging from "../../infra/outbound/delivery-queue-media-staging.js";
import { withStableDeliveryPreparation } from "../../infra/outbound/delivery-queue-preparation.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
  loadUnfinishedDeliveries,
} from "../../infra/outbound/delivery-queue-storage.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  configureDeletionAgents,
  createDeletionCron,
} from "./agents-delete.fixture.test-support.js";
import { deleteGatewayAgent } from "./agents-delete.js";

const outbound = {
  channel: "matrix",
  to: "!synthetic:example",
  payloads: [{ text: "retain original delivery custody" }],
  session: { agentId: "doomed" },
};
const runtime = useOutboundRuntime();
const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const postgresConnection = typeof configured === "string" ? configured : undefined;
let postgresFixture: { client: Client; prefix: string } | undefined;
function expectStateEngine(state: OpenClawTestState) {
  const engine = readBackupEngine(resolveOpenClawStateSqlitePath(state.env));
  expect(engine.engine).toBe(postgresFixture ? "postgres" : "sqlite");
  if (engine.engine === "postgres") {
    expect(engine.storeId).not.toBe("");
    expect(engine.namespace).toBe(
      `${postgresFixture?.prefix}_state_${engine.storeId.replaceAll("-", "").slice(0, 16)}`,
    );
  }
}
beforeEach(async () => {
  resetDatabaseEngineSelectionForTest();
  if (!postgresConnection) {
    return;
  }
  const prefix = `detach_custody_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const client = new Client({ connectionString: postgresConnection });
  await client.connect();
  postgresFixture = { client, prefix };
  expect(
    (
      await client.query("SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2", [
        prefix.length + 1,
        `${prefix}_`,
      ])
    ).rows,
  ).toEqual([]);
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({
      database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
    }),
    postgres: { connection: postgresConnection, schemaPrefix: prefix },
  });
});
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  resetDatabaseEngineSelectionForTest();
  const fixture = postgresFixture;
  postgresFixture = undefined;
  if (fixture) {
    try {
      const { rows } = await fixture.client.query(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [fixture.prefix.length + 1, `${fixture.prefix}_`],
      );
      for (const { nspname } of rows) {
        expect(nspname).toMatch(new RegExp(`^${fixture.prefix}_state_[a-f0-9]{16}$`, "u"));
        await fixture.client.query(
          `DROP SCHEMA ${fixture.client.escapeIdentifier(nspname)} CASCADE`,
        );
      }
    } finally {
      await fixture.client.end();
    }
  }
});

it("refuses detach while that agent owns outbound custody and restores its original admission", async () => {
  await withOpenClawTestState({ label: "detach-outbound-custody" }, async (state) => {
    await configureDeletionAgents(state);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    const id = await enqueueDelivery(outbound, state.stateDir);
    expectStateEngine(state);
    const before = await loadUnfinishedDeliveries(state.stateDir);
    const { context, stop } = createDeletionCron(state);
    try {
      await expect(deleteGatewayAgent("doomed", false, context, { detach: true })).rejects.toThrow(
        /outbound delivery.*retry/u,
      );
      expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
      expect(await readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual(before);
      await ackDelivery(id, state.stateDir);
      await expect(
        deleteGatewayAgent("doomed", false, context, { detach: true }),
      ).resolves.toMatchObject({
        ok: true,
        agentId: "doomed",
      });
    } finally {
      await stop();
    }
  });
});

it("refuses new custody after detach while preserving stable completed intent retries and unrelated agents", async () => {
  await withOpenClawTestState({ label: "detach-enqueue-fence" }, async (state) => {
    await configureDeletionAgents(state);
    const id = "settled-before-detach";
    const retained = { ...outbound, completionRetention: "permanent" as const };
    await enqueueDeliveryOnce(retained, id, state.stateDir);
    expectStateEngine(state);
    await ackDelivery(id, state.stateDir);
    const alreadyUnrelated = await enqueueDelivery(
      { ...outbound, session: { agentId: "keeper" } },
      state.stateDir,
    );
    const { context, stop } = createDeletionCron(state);
    try {
      await deleteGatewayAgent("doomed", false, context, { detach: true });
      await expect(enqueueDelivery(outbound, state.stateDir)).rejects.toMatchObject({
        queueCustody: "released",
        stage: "queue",
        cause: expect.any(OutboundDeliveryAdmissionClosedError),
      });
      await expect(enqueueDeliveryOnce(retained, id, state.stateDir)).resolves.toEqual({
        id,
        created: false,
      });
      await expect(
        enqueueDeliveryOnce(outbound, "new-stable", state.stateDir),
      ).rejects.toMatchObject({
        queueCustody: "released",
        cause: expect.any(OutboundDeliveryAdmissionClosedError),
      });
      await expect(
        withStableDeliveryPreparation({
          id: "new-prepared",
          stateDir: state.stateDir,
          run: async (owner) => {
            await owner.markPrepared();
            return enqueuePreparedDeliveryOnce(
              outbound,
              "new-prepared",
              await owner.current(),
              state.stateDir,
            );
          },
        }),
      ).rejects.toMatchObject({
        queueCustody: "released",
        cause: expect.any(OutboundDeliveryAdmissionClosedError),
      });
      const unrelated = await enqueueDelivery(
        { ...outbound, session: { agentId: "keeper" } },
        state.stateDir,
      );
      expect((await loadUnfinishedDeliveries(state.stateDir)).map((entry) => entry.id)).toEqual([
        alreadyUnrelated,
        unrelated,
      ]);
    } finally {
      await stop();
    }
  });
});

it.each([false, true])(
  "does not turn a detach refusal into best-effort physical delivery (media cleanup fails: %s)",
  async (cleanupFails) => {
    await withOpenClawTestState({ label: "detach-best-effort-send" }, async (state) => {
      await configureDeletionAgents(state);
      const cfg = getRuntimeConfig();
      const send = vi.fn(async () => matrixDeliveryResult("synthetic-effect"));
      installQueueTestPlugin({
        message: {
          id: "matrix",
          durableFinal: { capabilities: { text: true } },
          send: { text: send },
        },
      });
      const deliver = () => runtime.run({ ...outbound, cfg, queuePolicy: "best_effort" });
      await deliver();
      expectStateEngine(state);
      expect(send).toHaveBeenCalledOnce();
      send.mockClear();
      const { context, stop } = createDeletionCron(state);
      const entered = createDeferred();
      const released = createDeferred();
      const enqueue = queueAdmission.stageAndEnqueueOutboundDelivery;
      vi.spyOn(queueAdmission, "stageAndEnqueueOutboundDelivery").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await released.promise;
          return enqueue(...args);
        },
      );
      const delivery = deliver();
      const settled = Promise.allSettled([delivery]);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          delivery,
          "Prepared sender settled before its enqueue boundary",
        );
        await deleteGatewayAgent("doomed", false, context, { detach: true });
        if (cleanupFails) {
          vi.spyOn(mediaStaging, "cancelDeliveryQueueMediaRetention").mockRejectedValueOnce(
            new Error("synthetic media cleanup unavailable"),
          );
        }
        released.resolve();
        const result = await settled;
        expect(result[0]).toMatchObject({ status: "rejected" });
        if (!cleanupFails && result[0]?.status === "rejected") {
          expect(result[0].reason).toMatchObject({
            queueCustody: "released",
            cause: expect.any(OutboundDeliveryAdmissionClosedError),
          });
        }
        expect(send).not.toHaveBeenCalled();
        expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
      } finally {
        released.resolve();
        await settled;
        await stop();
      }
    });
  },
);

it("releases only a still-configured draining detach journal retained by an earlier owner", async () => {
  await withOpenClawTestState({ label: "detach-retained-draining" }, async (state) => {
    await configureDeletionAgents(state);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    await withAgentDeletion("doomed", async (begin) => {
      await begin({
        agentId: "doomed",
        agentDir: state.agentDir("doomed"),
        workspaceDir: state.path("doomed"),
        sessionsDir: state.sessionsDir("doomed"),
        deleteFiles: false,
        phase: "detach-draining",
      });
      await enqueueDelivery(outbound, state.stateDir);
      expectStateEngine(state);
    });
    expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
      phase: "detach-draining",
    });
    const { context, stop } = createDeletionCron(state);
    try {
      await expect(deleteGatewayAgent("doomed", false, context, { detach: true })).rejects.toThrow(
        /outbound delivery.*retry/u,
      );
      expect(await readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
      await expect(enqueueDelivery(outbound, state.stateDir)).resolves.toEqual(expect.any(String));
    } finally {
      await stop();
    }
  });
});

it.skipIf(Boolean(postgresConnection))(
  "preserves queued custody when the offline CLI resumes an interrupted draining detach",
  async () => {
    await withOpenClawTestState({ label: "detach-outbound-offline-cli" }, async (state) => {
      await configureDeletionAgents(state, undefined, { skipBootstrap: true });
      await fs.mkdir(state.path("doomed"), { recursive: true });
      await fs.writeFile(state.path("doomed/IDENTITY.md"), "Retained source identity.\n");
      const id = await enqueueDelivery(outbound, state.stateDir);
      expectStateEngine(state);
      const before = await fs.readFile(state.configPath, "utf8");
      await withAgentDeletion("doomed", async (begin) => {
        await begin({
          agentId: "doomed",
          agentDir: state.agentDir("doomed"),
          workspaceDir: state.path("doomed"),
          sessionsDir: state.sessionsDir("doomed"),
          deleteFiles: false,
          phase: "detach-draining",
        });
      });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      const cli = createCliProcessFixture(state.root, {
        ...state.env,
        OPENCLAW_TEST_RUNTIME_LOG: "1",
        OPENCLAW_DEBUG: undefined,
      });
      const result = await cli.run(["agents", "detach", "doomed", "--force", "--json"]);
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(result.stdout.trim(), JSON.stringify(result)).not.toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("unfinished outbound delivery") },
      });
      const human = await cli.run(["agents", "detach", "doomed", "--force"]);
      expect(human.code, JSON.stringify(human)).toBe(1);
      expect(human.stderr, JSON.stringify(human)).toContain("unfinished outbound delivery");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
      expect(await fs.readFile(state.path("doomed/IDENTITY.md"), "utf8")).toBe(
        "Retained source identity.\n",
      );
      expect(await readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      expect((await loadUnfinishedDeliveries(state.stateDir)).map((entry) => entry.id)).toEqual([
        id,
      ]);
    });
  },
);

it("preserves a retained retiring journal instead of rolling back uncertain prior cleanup", async () => {
  await withOpenClawTestState({ label: "detach-retained-retiring" }, async (state) => {
    await configureDeletionAgents(state);
    await enqueueDelivery(outbound, state.stateDir);
    expectStateEngine(state);
    await withAgentDeletion("doomed", async (begin) => {
      await begin({
        agentId: "doomed",
        agentDir: state.agentDir("doomed"),
        workspaceDir: state.path("doomed"),
        sessionsDir: state.sessionsDir("doomed"),
        deleteFiles: false,
        phase: "detach-retiring",
      });
    });
    const before = await loadUnfinishedDeliveries(state.stateDir);
    const { context, stop } = createDeletionCron(state);
    try {
      await expect(deleteGatewayAgent("doomed", false, context, { detach: true })).rejects.toThrow(
        /outbound delivery.*retry/u,
      );
      expect(await readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "detach-retiring",
        cleanupCompleted: false,
        deleteFiles: false,
      });
      expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual(before);
    } finally {
      await stop();
    }
  });
});

it("retains a genuine queued session final through refusal and lets its original delivery owner settle once", async () => {
  await withOpenClawTestState({ label: "detach-session-final" }, async (state) => {
    await configureDeletionAgents(state);
    const cfg = getRuntimeConfig();
    const target = {
      agentId: "doomed",
      sessionKey: "agent:doomed:matrix:direct:owner",
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "doomed" }),
    };
    const entry = { sessionId: "synthetic-final-session", updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    const payloads = [{ text: "Original completed answer" }];
    const marker = await persistMarker(target, entry, payloads);
    expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
    let online = false;
    const effects: string[] = [];
    installQueueTestPlugin({
      message: {
        id: "matrix",
        durableFinal: { capabilities: { text: true } },
        send: {
          text: async ({ text }) => {
            if (!online) {
              throw new PlatformMessageNotDispatchedError("synthetic receiver offline", {
                cause: undefined,
              });
            }
            effects.push(text);
            return matrixDeliveryResult("synthetic-final-effect");
          },
        },
      },
    });
    await expect(
      deliverFinal(target, {
        cfg,
        opts: {
          message: "Complete the original request",
          deliver: true,
          replyChannel: "matrix",
          replyTo: "!owner:example",
          accountId: "default",
          sessionKey: target.sessionKey,
          runId: "synthetic-final-run",
        },
        sessionEntry: marker.sessionEntry,
        result: { meta: { durationMs: 1 } },
        payloads,
      }),
    ).rejects.toThrow();
    expect(effects).toEqual([]);
    const before = await loadUnfinishedDeliveries(state.stateDir);
    expectStateEngine(state);
    expect(before).toHaveLength(1);
    expect(before[0]?.deliveryCompletion).toMatchObject({
      kind: "pending-final",
      agentId: "doomed",
      intentId: marker.pendingFinalDeliveryIntentId,
    });
    const { context, stop } = createDeletionCron(state);
    try {
      await expect(deleteGatewayAgent("doomed", false, context, { detach: true })).rejects.toThrow(
        /outbound delivery.*retry/u,
      );
      expect(await readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual(before);
      expect((await readSessionEntryReadOnlyInWorker(target))?.pendingFinalDelivery?.intentId).toBe(
        marker.pendingFinalDeliveryIntentId,
      );
      online = true;
      const recover = recoveryFor(cfg, state.stateDir, "detach-session-final");
      await recover();
      await recover();
      expect(effects).toEqual(["Original completed answer"]);
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
      expect(
        (await readSessionEntryReadOnlyInWorker(target))?.pendingFinalDelivery?.deliveries,
      ).toEqual([
        {
          id:
            before[0]?.deliveryCompletion?.kind === "pending-final"
              ? before[0].deliveryCompletion.deliveryId
              : undefined,
          state: "delivered",
        },
      ]);
      await expect(
        deleteGatewayAgent("doomed", false, context, { detach: true }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await stop();
    }
  });
});
