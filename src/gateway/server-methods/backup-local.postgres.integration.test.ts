import "../server-start.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCliProcessFixture } from "../../cli/isolated-process-fixture.test-support.js";
import type { CronJob } from "../../cron/types.js";
import { getDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../../infra/device-identity.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { readBackupEngine, type BackupEngine } from "../../snapshot/database-backup.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
type PostgresIdentity = Extract<BackupEngine, { engine: "postgres" }>;

beforeEach(resetDatabaseEngineSelectionForTest);
afterEach(resetDatabaseEngineSelectionForTest);

it.skipIf(!connection)(
  "moves a closed Builder through the actual local checkpoint CLI without detaching its PostgreSQL agent",
  async () => {
    const testConnection = connection;
    if (!testConnection) {
      throw new Error("PostgreSQL conformance preload is required");
    }
    const prefix = `checkpoint_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await withOpenClawTestState(
      {
        layout: "split",
        label: "builder-local-checkpoint",
        env: { ...deletionGatewayEnv, OPENCLAW_CHECKPOINT_TEST_DSN: testConnection },
      },
      async (state) => {
        await using cleanup = new AsyncDisposableStack();
        const identities = new Map<string, PostgresIdentity>();
        const departed = state.path("departed-source");
        const departedState = path.join(departed, "state");
        const anchorPath = resolveOpenClawAgentSqlitePath({ agentId: "builder", env: state.env });
        const departedAnchor = path.join(departedState, path.relative(state.stateDir, anchorPath));
        const started = performance.now();
        const stage = (name: string) =>
          process.stderr.write(
            `${JSON.stringify({
              fixture: "builder-local-checkpoint",
              prefix,
              stage: name,
              elapsedMs: Math.round(performance.now() - started),
              identities: [...identities.values()],
            })}\n`,
          );
        const rememberAnchor = (file: string) => {
          const engine = readBackupEngine(file);
          if (engine.engine === "postgres") {
            expect(engine.namespace).toBe(
              `${prefix}_agent_${engine.storeId.replaceAll("-", "").slice(0, 16)}`,
            );
            identities.set(engine.namespace, engine);
          }
          return engine;
        };
        const database = new Client({ connectionString: testConnection });
        await database.connect();
        cleanup.defer(() => database.end());
        expect((await database.query("SELECT current_database() AS name")).rows).toEqual([
          { name: decodeURIComponent(new URL(testConnection).pathname.slice(1)) },
        ]);
        expect(
          (
            await database.query("SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2", [
              prefix.length + 1,
              `${prefix}_`,
            ])
          ).rows,
        ).toEqual([]);
        cleanup.defer(async () => {
          stage("namespace cleanup started");
          // Only Native-created anchors from this exact installation and its retained source.
          for (const file of [anchorPath, departedAnchor]) {
            try {
              await fs.stat(file);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
              }
              throw error;
            }
            rememberAnchor(file);
          }
          for (const identity of identities.values()) {
            expect(identity.namespace).toMatch(new RegExp(`^${prefix}_agent_[a-f0-9]{16}$`, "u"));
            expect(
              (
                await database.query(
                  `SELECT store_id FROM "${identity.namespace}".openclaw_schema_meta WHERE store = 'agent'`,
                )
              ).rows,
            ).toEqual([{ store_id: identity.storeId }]);
            await database.query(`DROP SCHEMA "${identity.namespace}" CASCADE`);
          }
          stage("namespace cleanup completed");
        });
        stage("unused PostgreSQL fixture scope verified");
        const token = "synthetic-builder-checkpoint-token";
        await state.writeConfig({
          database: {
            engine: "sqlite",
            families: { agent: { engine: "postgres" } },
            postgres: {
              connection: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_CHECKPOINT_TEST_DSN",
              },
              schemaPrefix: prefix,
            },
          },
          gateway: { mode: "local", auth: { mode: "token", token } },
          agents: {
            ownership: "explicit",
            defaults: { skipBootstrap: true },
            entries: { builder: { workspace: state.workspaceDir } },
          },
          plugins: { enabled: false },
        });
        const authored = Buffer.from("# Builder\nRetain this authored workspace.\n");
        const binary = Buffer.from([0, 255, 1, 128, 10, 42]);
        await fs.writeFile(path.join(state.workspaceDir, "AGENTS.md"), authored);
        await fs.writeFile(path.join(state.workspaceDir, "reference.bin"), binary);
        // The ordinary Native client owner creates a real device identity before first boot.
        const deviceIdentity = loadOrCreateDeviceIdentity({ env: state.env });
        const claim = await acquireTestPortBlock({ offsets: [0, 2] });
        cleanup.defer(() => claim.release());
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        let gatewayOwner: Awaited<ReturnType<typeof acquireGatewayLock>> = null;
        let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
        const start = async () => {
          // Match the CLI run loop's durable service custody, not an embedded-only listener.
          gatewayOwner = await acquireGatewayLock({
            env: state.env,
            port: claim.port,
            listenerMode: "foreground",
            allowInTests: true,
          });
          if (!gatewayOwner) {
            throw new Error("Checkpoint Gateway ownership was not acquired");
          }
          server = await startGatewayServer(claim.port, {
            gatewayStateOwner: gatewayOwner,
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
            hotReloadRecovery() {
              throw new Error("Checkpoint replacement unexpectedly required Gateway recovery");
            },
          });
          await server.startupSettled;
          expect(getDatabaseEngineSelection()?.effectiveEngines).toMatchObject({
            state: "sqlite",
            agent: "postgres",
          });
          client = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin"],
            deviceIdentity,
          });
          return client;
        };
        const stop = async () => {
          try {
            if (client) {
              await disconnectGatewayClient(client);
              client = undefined;
            }
          } finally {
            try {
              if (server) {
                await server.close();
                server = undefined;
              }
            } finally {
              try {
                // Lease settlement can reopen shared state; close fixture readers afterward.
                await gatewayOwner?.release();
                gatewayOwner = null;
              } finally {
                await cleanupSessionStateForTest({
                  stateDir: state.stateDir,
                  rootPath: state.root,
                });
              }
            }
          }
        };
        try {
          const source = await start();
          const key = "agent:builder:checkpoint";
          const created = await source.request<{ sessionId: string }>("sessions.create", {
            agentId: "builder",
            key,
          });
          const originalEngine = rememberAnchor(anchorPath);
          expect(originalEngine.engine).toBe("postgres");
          await source.request("chat.inject", {
            sessionKey: key,
            message: "History survives a whole Builder checkpoint.",
          });
          const originalHistory = await source.request<{ sessionId: string; messages: unknown[] }>(
            "chat.history",
            { sessionKey: key },
          );
          expect(originalHistory.sessionId).toBe(created.sessionId);
          expect(originalHistory.messages).toHaveLength(1);
          const roster = await source.request<{ agents: { id: string }[] }>("agents.list", {});
          expect(roster.agents.map((agent) => agent.id)).toEqual(["builder"]);
          const job = await source.request<CronJob>("cron.add", {
            name: "Synthetic Builder schedule",
            agentId: "builder",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: {
              kind: "agentTurn",
              message: "Synthetic checkpoint schedule",
              toolsAllow: [],
            },
            delivery: { mode: "none" },
          });
          const operationId = "builder-checkpoint-hold";
          await expect(
            source.request("cron.migration", { operationId, phase: "hold", agentIds: ["builder"] }),
          ).resolves.toMatchObject({ operationId, phase: "hold", drained: true });
          stage("real PostgreSQL history, roster, schedule and hold seeded");
          const cli = createCliProcessFixture(state.root, {
            ...state.env,
            OPENCLAW_TEST_RUNTIME_LOG: "1",
          });
          const archive = state.path("builder-local.tar.gz");
          const refused = await cli.run([
            "backup",
            "local",
            "create",
            "--output",
            archive,
            "--require-empty-delivery-queues",
            "--json",
          ]);
          expect(refused.code, JSON.stringify(refused)).not.toBe(0);
          expect(JSON.parse(refused.stdout), JSON.stringify(refused)).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("exclusive offline state ownership") },
          });
          await expect(fs.stat(archive)).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            await source.request<typeof originalHistory>("chat.history", { sessionKey: key }),
          ).toMatchObject({
            sessionId: originalHistory.sessionId,
            messages: originalHistory.messages,
          });
          const online = await cli.run([
            "backup",
            "local",
            "create",
            "--output",
            state.path("ordinary-online.tar.gz"),
            "--json",
          ]);
          expect(online.code, JSON.stringify(online)).toBe(0);
          expect(JSON.parse(online.stdout)).toMatchObject({ ok: true });
          await stop();
          stage("live guarded refusal and ordinary online capture verified; source owners closed");
          const captured = await cli.run([
            "backup",
            "local",
            "create",
            "--output",
            archive,
            "--require-empty-delivery-queues",
            "--json",
          ]);
          const captureDiagnostic = JSON.stringify(captured);
          expect(captured.code, captureDiagnostic).toBe(0);
          expect(captured.stdout.trim(), captureDiagnostic).not.toBe("");
          expect(JSON.parse(captured.stdout)).toMatchObject({
            ok: true,
            archivePath: archive,
            databaseCount: 3,
          });
          stage("actual CLI local checkpoint created");
          const configBytes = await fs.readFile(state.configPath);
          await fs.mkdir(departed, { mode: 0o700 });
          await fs.rename(state.stateDir, departedState);
          await fs.rename(path.dirname(state.configPath), path.join(departed, "config"));
          await fs.rename(state.workspaceDir, path.join(departed, "workspace"));
          const departedGlobal = path.join(departedState, "state", "openclaw.sqlite");
          const sourceHash = createHash("sha256")
            .update(await fs.readFile(departedGlobal))
            .digest("hex");
          await fs.mkdir(state.stateDir, { mode: 0o700 });
          expect(await fs.readdir(state.stateDir)).toEqual([]);
          await fs.mkdir(path.dirname(state.configPath), { mode: 0o700 });
          await fs.copyFile(path.join(departed, "config", "openclaw.json"), state.configPath);
          await fs.cp(path.join(departed, "workspace"), state.workspaceDir, { recursive: true });
          expect(await fs.readFile(state.configPath)).toEqual(configBytes);
          const restored = await cli.run(["backup", "local", "restore", archive, "--json"]);
          const restoreDiagnostic = JSON.stringify(restored);
          expect(restored.code, restoreDiagnostic).toBe(0);
          expect(restored.stdout.trim(), restoreDiagnostic).not.toBe("");
          expect(JSON.parse(restored.stdout)).toMatchObject({
            ok: true,
            archivePath: archive,
            stateDir: state.stateDir,
            databaseCount: 3,
          });
          expect(rememberAnchor(anchorPath)).toEqual(originalEngine);
          expect(rememberAnchor(departedAnchor)).toEqual(originalEngine);
          expect(loadDeviceIdentityIfPresent({ env: state.env })).toEqual(deviceIdentity);
          stage("actual CLI restored fresh targets with original agent and client identities");
          const replacement = await start();
          stage("replacement Gateway ready without detach or agent recreation");
          expect(
            (await replacement.request<typeof roster>("agents.list", {})).agents.map(
              (agent) => agent.id,
            ),
          ).toEqual(["builder"]);
          const restoredHistory = await replacement.request<typeof originalHistory>(
            "chat.history",
            {
              sessionKey: key,
            },
          );
          expect(restoredHistory.sessionId).toBe(originalHistory.sessionId);
          expect(restoredHistory.messages).toEqual(originalHistory.messages);
          expect(rememberAnchor(anchorPath)).toEqual(originalEngine);
          expect(await fs.readFile(path.join(state.workspaceDir, "AGENTS.md"))).toEqual(authored);
          expect(await fs.readFile(path.join(state.workspaceDir, "reference.bin"))).toEqual(binary);
          const jobs = await replacement.request<{ jobs: CronJob[] }>("cron.list", {
            includeDisabled: true,
          });
          expect(jobs.jobs).toContainEqual(
            expect.objectContaining({
              id: job.id,
              name: job.name,
              agentId: job.agentId,
              enabled: job.enabled,
              schedule: job.schedule,
              sessionTarget: job.sessionTarget,
              wakeMode: job.wakeMode,
              payload: job.payload,
              delivery: job.delivery,
            }),
          );
          await expect(
            replacement.request("cron.update", {
              id: job.id,
              patch: { name: "Refused while held" },
            }),
          ).rejects.toThrow(`is held for migration ${operationId}`);
          await expect(
            replacement.request("cron.run", { id: job.id, mode: "force" }),
          ).resolves.toMatchObject({ ok: true, ran: false });
          stage("complete history, authored files, ordinary job and durable hold verified");
          // The departed source remains stopped and retained; only the replacement resumes.
          await expect(
            replacement.request("cron.migration", { operationId, phase: "resume" }),
          ).resolves.toMatchObject({ operationId, phase: "resume", drained: true });
          await replacement.request("cron.update", {
            id: job.id,
            patch: { name: "Resumed Builder schedule" },
          });
          await replacement.request("chat.inject", {
            sessionKey: key,
            message: "Replacement Builder can append history.",
          });
          const continued = await replacement.request<typeof originalHistory>("chat.history", {
            sessionKey: key,
          });
          expect(continued.sessionId).toBe(originalHistory.sessionId);
          expect(continued.messages).toHaveLength(2);
          expect(continued.messages[0]).toEqual(originalHistory.messages[0]);
          expect(rememberAnchor(anchorPath)).toEqual(originalEngine);
          expect(
            createHash("sha256")
              .update(await fs.readFile(departedGlobal))
              .digest("hex"),
          ).toBe(sourceHash);
          expect(await fs.readFile(path.join(departed, "config", "openclaw.json"))).toEqual(
            configBytes,
          );
          stage("replacement resumed and appended; departed source files unchanged");
        } finally {
          await stop();
          stage("final Gateway closed");
        }
      },
    );
  },
  120_000,
);
