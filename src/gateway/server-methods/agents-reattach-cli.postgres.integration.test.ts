import "../server-start.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { getCliProcessTestTimeout } from "../../cli/cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "../../cli/isolated-process-fixture.test-support.js";
import type { CronJob } from "../../cron/types.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { loadOrCreateDeviceIdentity } from "../../infra/device-identity.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { readBackupEngine, type BackupEngine } from "../../snapshot/database-backup.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { VERSION } from "../../version.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import { deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
type PostgresIdentity = Extract<BackupEngine, { engine: "postgres" }>;
beforeEach(resetDatabaseEngineSelectionForTest);
afterEach(resetDatabaseEngineSelectionForTest);

it.skipIf(!connection)(
  "reattaches an already-configured completed tombstone through the actual CLI without replacing its PostgreSQL store",
  async () => {
    if (!connection) {
      throw new Error("PostgreSQL conformance preload is required");
    }
    const prefix = `reattach_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await withOpenClawTestState(
      {
        label: "retained-agent-reattach",
        env: { ...deletionGatewayEnv, OPENCLAW_REATTACH_TEST_DSN: connection },
      },
      async (state) => {
        await using cleanup = new AsyncDisposableStack();
        const identities = new Map<string, PostgresIdentity>();
        const started = performance.now();
        const stage = (name: string, result?: unknown) =>
          process.stderr.write(
            `${JSON.stringify({ fixture: "retained-agent-reattach", prefix, stage: name, elapsedMs: Math.round(performance.now() - started), identities: [...identities.values()], ...(result ? { result } : {}) })}\n`,
          );
        const remember = (agentId: string) => {
          const identity = readBackupEngine(
            resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
          );
          expect(identity.engine).toBe("postgres");
          if (identity.engine !== "postgres") {
            throw new Error("Expected Native-created PostgreSQL anchor");
          }
          expect(identity.namespace).toBe(
            `${prefix}_agent_${identity.storeId.replaceAll("-", "").slice(0, 16)}`,
          );
          identities.set(identity.namespace, identity);
          return identity;
        };
        const database = new Client({ connectionString: connection });
        await database.connect();
        cleanup.defer(() => database.end());
        expect((await database.query("SELECT current_database() AS name")).rows).toEqual([
          { name: decodeURIComponent(new URL(connection).pathname.slice(1)) },
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
          for (const agentId of ["keeper", "traveler", "mismatched", "missing"]) {
            const anchor = resolveOpenClawAgentSqlitePath({ agentId, env: state.env });
            try {
              await fs.stat(anchor);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
              }
              throw error;
            }
            remember(agentId);
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
          expect(
            (
              await database.query(
                "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
                [prefix.length + 1, `${prefix}_`],
              )
            ).rows,
          ).toEqual([]);
          stage("namespace cleanup completed");
        });
        const token = "synthetic-retained-reattach-token";
        await state.writeConfig({
          database: {
            engine: "sqlite",
            families: { agent: { engine: "postgres" } },
            postgres: {
              connection: { source: "env", provider: "default", id: "OPENCLAW_REATTACH_TEST_DSN" },
              schemaPrefix: prefix,
            },
          },
          gateway: { mode: "local", auth: { mode: "token", token } },
          agents: {
            ownership: "explicit",
            defaults: { skipBootstrap: true },
            entries: {
              keeper: { workspace: state.workspaceDir },
              traveler: { workspace: state.path("traveler-workspace") },
              mismatched: { workspace: state.path("mismatched-workspace") },
              missing: { workspace: state.path("missing-workspace") },
            },
          },
          plugins: { enabled: false },
        });
        const deviceIdentity = loadOrCreateDeviceIdentity({ env: state.env });
        const claim = await acquireTestPortBlock({ offsets: [0, 2] });
        cleanup.defer(() => claim.release());
        let owner: Awaited<ReturnType<typeof acquireGatewayLock>> = null;
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
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
                await owner?.release();
                owner = null;
              } finally {
                await cleanupSessionStateForTest({
                  stateDir: state.stateDir,
                  rootPath: state.root,
                });
              }
            }
          }
        };
        const start = async () => {
          owner = await acquireGatewayLock({
            env: state.env,
            port: claim.port,
            listenerMode: "foreground",
            allowInTests: true,
          });
          if (!owner) {
            throw new Error("Native Gateway custody was not acquired");
          }
          server = await startGatewayServer(claim.port, {
            gatewayStateOwner: owner,
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
            hotReloadRecovery() {
              throw new Error("Retained-agent detach unexpectedly required Gateway recovery");
            },
          });
          await server.startupSettled;
          client = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin"],
            deviceIdentity,
          });
          return client;
        };
        try {
          const source = await start();
          const key = "agent:traveler:retained-vm";
          const created = await source.request<{ sessionId: string }>("sessions.create", {
            agentId: "traveler",
            key,
          });
          const originalEngine = remember("traveler");
          const controlEngines = new Map<string, PostgresIdentity>();
          for (const agentId of ["mismatched", "missing"]) {
            await source.request("sessions.create", { agentId, key: `agent:${agentId}:control` });
            controlEngines.set(agentId, remember(agentId));
          }
          await source.request("chat.inject", {
            sessionKey: key,
            message: "Preserve all retained-VM transcript bytes.",
          });
          const history = await source.request<{ sessionId: string; messages: unknown[] }>(
            "chat.history",
            { sessionKey: key },
          );
          expect(history.sessionId).toBe(created.sessionId);
          expect(history.messages).toHaveLength(1);
          const job = await source.request<CronJob>("cron.add", {
            name: "Retained traveler schedule",
            agentId: "traveler",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Synthetic schedule", toolsAllow: [] },
            delivery: { mode: "none" },
          });
          await source.request("cron.migration", {
            operationId: "retained-traveler-handoff",
            phase: "hold",
            agentIds: ["traveler"],
          });
          await source.request("cron.migration", {
            operationId: "retained-traveler-handoff",
            phase: "export",
          });
          const authoredConfig = await fs.readFile(state.configPath, "utf8");
          for (const agentId of ["traveler", "mismatched", "missing"]) {
            await expect(source.request("agents.detach", { agentId })).resolves.toMatchObject({
              ok: true,
              agentId,
            });
          }
          await stop();
          // The retained installation remains physically in place; only its authored roster returns.
          await fs.writeFile(state.configPath, authoredConfig);
          const completed = new Map(
            ["traveler", "mismatched", "missing"].map((agentId) => {
              const entry = readAgentDeletionJournal(agentId, { env: state.env });
              expect(entry).toMatchObject({ cleanupCompleted: true, deleteFiles: false });
              return [agentId, entry] as const;
            }),
          );
          expect(remember("traveler")).toEqual(originalEngine);
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          const cli = createCliProcessFixture(state.root, {
            ...state.env,
            OPENCLAW_TEST_RUNTIME_LOG: "1",
          });
          const argsFor = (agentId: string) => [
            "agents",
            "add",
            agentId,
            "--workspace",
            state.path(`${agentId}-workspace`),
            "--agent-dir",
            state.agentDir(agentId),
            "--non-interactive",
            "--json",
          ];
          const args = argsFor("traveler");
          stage("real detach completed; original authored roster restored");
          const listed = await cli.run(["agents", "list", "--json"]);
          expect(listed.code, JSON.stringify(listed)).toBe(0);
          expect(JSON.parse(listed.stdout)).toContainEqual(
            expect.objectContaining({
              id: "traveler",
              workspace: state.path("traveler-workspace"),
              agentDir: state.agentDir("traveler"),
            }),
          );
          expect(readAgentDeletionJournal("traveler", { env: state.env })).toEqual(
            completed.get("traveler"),
          );
          stage("public CLI lists canonical paths despite completed tombstone");
          const mismatchArgs = argsFor("mismatched");
          mismatchArgs[mismatchArgs.indexOf("--agent-dir") + 1] = state.path("wrong-agent-dir");
          const mismatch = await cli.run(mismatchArgs);
          expect(mismatch.code, JSON.stringify(mismatch)).toBe(1);
          expect
            .soft(
              readAgentDeletionJournal("mismatched", { env: state.env }),
              "wrong-directory refusal must retain its completed tombstone",
            )
            .toEqual(completed.get("mismatched"));
          expect(await fs.readFile(state.configPath, "utf8")).toBe(authoredConfig);
          expect(remember("traveler")).toEqual(originalEngine);
          stage("wrong-directory result", mismatch);
          const anchor = resolveOpenClawAgentSqlitePath({ agentId: "missing", env: state.env });
          await fs.rename(anchor, `${anchor}.fixture-retained`);
          const missing = await cli.run(argsFor("missing"));
          expect(missing.code, JSON.stringify(missing)).toBe(1);
          expect
            .soft(
              readAgentDeletionJournal("missing", { env: state.env }),
              "missing-store refusal must retain its completed tombstone",
            )
            .toEqual(completed.get("missing"));
          await expect(fs.stat(anchor)).rejects.toMatchObject({ code: "ENOENT" });
          stage("missing-store result", missing);
          await fs.rename(`${anchor}.fixture-retained`, anchor);
          for (const [agentId, original] of controlEngines) {
            const restored = await cli.run(argsFor(agentId));
            expect(restored.code, JSON.stringify(restored)).toBe(0);
            expect(JSON.parse(restored.stdout)).toMatchObject({
              agentId,
              workspace: state.path(`${agentId}-workspace`),
              agentDir: state.agentDir(agentId),
            });
            expect(remember(agentId)).toEqual(original);
            expect(readAgentDeletionJournal(agentId, { env: state.env })).toBeUndefined();
          }
          stage("negative controls reattached through positive public CLI receipts");
          const added = await cli.run(args);
          stage("canonical retained-store CLI result", added);
          expect(remember("traveler")).toEqual(originalEngine);
          // The existing config writer stamps only its three auto-managed metadata fields.
          // All authored values, including the complete roster, must remain exact.
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
            ...JSON.parse(authoredConfig),
            meta: {
              migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
              lastTouchedVersion: VERSION,
            },
          });
          // Positive Native success is required; a duplicate-error side effect is not a receipt.
          expect(added.code, JSON.stringify(added)).toBe(0);
          expect(JSON.parse(added.stdout)).toMatchObject({
            agentId: "traveler",
            workspace: state.path("traveler-workspace"),
            agentDir: state.agentDir("traveler"),
          });
          expect(readAgentDeletionJournal("traveler", { env: state.env })).toBeUndefined();
          const duplicate = await cli.run(args);
          expect(duplicate.code, JSON.stringify(duplicate)).toBe(1);
          expect(JSON.parse(duplicate.stdout)).toMatchObject({
            ok: false,
            error: { message: 'agent "traveler" already exists' },
          });
          stage("fresh executable replacement Gateway starting");
          const replacement = createCliProcessFixture(state.root, {
            ...state.env,
            OPENCLAW_TEST_RUNTIME_LOG: "1",
            OPENCLAW_TEST_CONSOLE: "1",
          });
          const replacementResult = await replacement.run(
            ["gateway", "run", "--bind", "loopback", "--port", String(claim.port)],
            async (child) => {
              try {
                let output = "";
                let record: (chunk: Buffer | string) => void = () => {};
                try {
                  await new Promise<void>((resolve, reject) => {
                    record = (chunk) => {
                      output += chunk.toString();
                      if (/\[gateway\] ready(?:\r?\n|$)/u.test(output)) {
                        resolve();
                      }
                    };
                    child.stdout.on("data", record);
                    child.stderr.on("data", record);
                    void once(child, "exit").then(
                      () =>
                        reject(new Error(`Replacement exited before Native readiness: ${output}`)),
                      reject,
                    );
                  });
                } finally {
                  child.stdout.off("data", record);
                  child.stderr.off("data", record);
                }
                stage("fresh executable replacement Gateway ready");
                const restored = await connectGatewayClient({
                  url: `ws://127.0.0.1:${claim.port}`,
                  token,
                  scopes: ["operator.admin"],
                  deviceIdentity,
                });
                try {
                  expect(remember("traveler")).toEqual(originalEngine);
                  const restoredHistory = await restored.request<{
                    sessionId: string;
                    messages: unknown[];
                  }>("chat.history", { sessionKey: key });
                  expect(restoredHistory.sessionId).toBe(history.sessionId);
                  expect(restoredHistory.messages).toEqual(history.messages);
                  const roster = await restored.request<{ agents: { id: string }[] }>(
                    "agents.list",
                    {},
                  );
                  expect(roster.agents.map((a) => a.id).toSorted()).toEqual([
                    "keeper",
                    "mismatched",
                    "missing",
                    "traveler",
                  ]);
                  const jobs = await restored.request<{ jobs: CronJob[] }>("cron.list", {
                    includeDisabled: true,
                  });
                  expect(jobs.jobs).toContainEqual(
                    expect.objectContaining({
                      id: job.id,
                      agentId: job.agentId,
                      payload: job.payload,
                      schedule: job.schedule,
                    }),
                  );
                  await expect(
                    restored.request("cron.update", { id: job.id, patch: { name: "Still held" } }),
                  ).rejects.toThrow("is held for migration retained-traveler-handoff");
                  expect(
                    await restored.request("cron.run", { id: job.id, mode: "force" }),
                  ).toMatchObject({
                    ok: true,
                    ran: false,
                  });
                  await restored.request("cron.migration", {
                    operationId: "retained-traveler-handoff",
                    phase: "resume",
                  });
                  await expect(
                    restored.request("chat.inject", {
                      sessionKey: key,
                      message: "Reattached agent can write.",
                    }),
                  ).resolves.toMatchObject({ ok: true });
                  stage("positive reattachment, full history, jobs, hold and new write verified");
                } finally {
                  await disconnectGatewayClient(restored);
                }
              } finally {
                await stopChildProcess(child, 10_000);
              }
            },
          );
          expect(replacementResult.code, JSON.stringify(replacementResult)).toBe(0);
          expect(replacementResult.signal).toBeNull();
          stage("fresh executable replacement Gateway cleanly exited");
        } finally {
          await stop();
        }
      },
    );
  },
  getCliProcessTestTimeout(100_000, 100_000),
);

it("refuses actual CLI reattachment while Native deletion cleanup is pending", async () => {
  await withOpenClawTestState(
    { label: "pending-agent-reattach", scenario: "minimal" },
    async (state) => {
      await state.writeConfig({
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true },
          entries: { interrupted: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
      });
      const pending = beginAgentDeletionJournal(
        {
          agentId: "interrupted",
          operationId: randomUUID(),
          agentDir: state.agentDir("interrupted"),
          workspaceDir: state.workspaceDir,
          sessionsDir: state.sessionsDir("interrupted"),
          deleteFiles: false,
        },
        { env: state.env },
      );
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const cli = createCliProcessFixture(state.root, {
        ...state.env,
        OPENCLAW_TEST_RUNTIME_LOG: "1",
      });
      const result = await cli.run([
        "agents",
        "add",
        "interrupted",
        "--workspace",
        state.workspaceDir,
        "--agent-dir",
        state.agentDir("interrupted"),
        "--non-interactive",
        "--json",
      ]);
      expect(result.code, JSON.stringify(result)).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("deletion cleanup is still pending") },
      });
      expect(readAgentDeletionJournal("interrupted", { env: state.env })).toEqual(pending);
    },
  );
});

for (const engine of ["sqlite", "postgres"] as const) {
  it.skipIf(engine === "postgres" && !connection)(
    `refuses actual CLI restoration of a missing logical store behind an existing ${engine} file`,
    async () => {
      const prefix = `reattach_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await withOpenClawTestState(
        {
          label: `missing-logical-${engine}`,
          scenario: "minimal",
          env: connection ? { OPENCLAW_REATTACH_TEST_DSN: connection } : {},
        },
        async (state) => {
          await using cleanup = new AsyncDisposableStack();
          const database =
            engine === "postgres" ? new Client({ connectionString: connection }) : null;
          let identity: PostgresIdentity | undefined;
          if (database) {
            await database.connect();
            cleanup.defer(() => database.end());
            expect((await database.query("SELECT current_database() AS name")).rows).toEqual([
              { name: decodeURIComponent(new URL(connection!).pathname.slice(1)) },
            ]);
            expect(
              (
                await database.query(
                  "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
                  [prefix.length + 1, `${prefix}_`],
                )
              ).rows,
            ).toEqual([]);
            cleanup.defer(async () => {
              if (
                identity &&
                (
                  await database.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [
                    identity.namespace,
                  ])
                ).rowCount
              ) {
                expect(identity.namespace).toBe(
                  `${prefix}_agent_${identity.storeId.replaceAll("-", "").slice(0, 16)}`,
                );
                expect(
                  (
                    await database.query(
                      `SELECT store_id FROM "${identity.namespace}".openclaw_schema_meta WHERE store = 'agent'`,
                    )
                  ).rows,
                ).toEqual([{ store_id: identity.storeId }]);
                await database.query(`DROP SCHEMA "${identity.namespace}" CASCADE`);
              }
              expect(
                (
                  await database.query(
                    "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
                    [prefix.length + 1, `${prefix}_`],
                  )
                ).rows,
              ).toEqual([]);
            });
          }
          await state.writeConfig({
            database: {
              engine: "sqlite",
              ...(database
                ? {
                    families: { agent: { engine: "postgres" } },
                    postgres: {
                      connection: {
                        source: "env",
                        provider: "default",
                        id: "OPENCLAW_REATTACH_TEST_DSN",
                      },
                      schemaPrefix: prefix,
                    },
                  }
                : {}),
            },
            gateway: { mode: "local" },
            agents: {
              ownership: "explicit",
              defaults: { skipBootstrap: true },
              entries: { keeper: { workspace: state.workspaceDir } },
            },
            plugins: { enabled: false },
          });
          const cli = createCliProcessFixture(state.root, {
            ...state.env,
            OPENCLAW_TEST_RUNTIME_LOG: "1",
          });
          const args = [
            "agents",
            "add",
            "traveler",
            "--workspace",
            state.path("traveler-workspace"),
            "--agent-dir",
            state.agentDir("traveler"),
            "--non-interactive",
            "--json",
          ];
          const created = await cli.run(args);
          expect(created.code, JSON.stringify(created)).toBe(0);
          const authored = await fs.readFile(state.configPath, "utf8");
          const anchor = resolveOpenClawAgentSqlitePath({ agentId: "traveler", env: state.env });
          if (database) {
            const captured = readBackupEngine(anchor);
            expect(captured.engine).toBe("postgres");
            if (captured.engine !== "postgres") {
              throw new Error("Expected Native-created PG store");
            }
            identity = captured;
            expect(identity.namespace).toBe(
              `${prefix}_agent_${identity.storeId.replaceAll("-", "").slice(0, 16)}`,
            );
          }
          const detached = await cli.run(["agents", "detach", "traveler", "--force", "--json"]);
          expect(detached.code, JSON.stringify(detached)).toBe(0);
          await fs.writeFile(state.configPath, authored);
          const completed = readAgentDeletionJournal("traveler", { env: state.env });
          expect(completed).toMatchObject({ cleanupCompleted: true, deleteFiles: false });
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          if (database && identity) {
            expect(
              (
                await database.query(
                  `SELECT store_id FROM "${identity.namespace}".openclaw_schema_meta WHERE store = 'agent'`,
                )
              ).rows,
            ).toEqual([{ store_id: identity.storeId }]);
            await database.query(`DROP SCHEMA "${identity.namespace}" CASCADE`);
          } else {
            await fs.writeFile(anchor, "");
          }
          const originalAnchor = await fs.readFile(anchor);
          const restored = await cli.run(args);
          expect.soft(restored.code, JSON.stringify(restored)).toBe(1);
          expect.soft(readAgentDeletionJournal("traveler", { env: state.env })).toEqual(completed);
          expect
            .soft(
              (await fs.readFile(anchor)).equals(originalAnchor),
              "retained anchor bytes must remain exact",
            )
            .toBe(true);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(authored);
          if (database && identity) {
            expect
              .soft(
                (
                  await database.query("SELECT nspname FROM pg_namespace WHERE nspname = $1", [
                    identity.namespace,
                  ])
                ).rows,
              )
              .toEqual([]);
          } else {
            expect.soft((await fs.stat(anchor)).size).toBe(0);
          }
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        },
      );
    },
    getCliProcessTestTimeout(60_000),
  );
}
