import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { restoreRetainedPostgresRoster } from "./agents-restore-many.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  inspect: vi.fn(),
  journal: vi.fn(),
  publish: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("../../infra/database-engine/context.js", () => ({
  getDatabaseEngineInput: () => ({ connection: "unused" }),
}));
vi.mock("../../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionRecoveryHoldsInWorker: async () => [],
  readAgentDeletionJournalForCreation: mocks.journal,
}));
vi.mock("../../agents/agent-create-restoration.js", () => ({
  settleAgentCreationTombstone: mocks.settle,
}));
vi.mock("../../state/openclaw-agent-schema-inspection-worker.js", () => ({
  createAgentSchemaInspectionWorker: () => ({
    inspect: mocks.inspect,
    [Symbol.asyncDispose]: async () => {},
  }),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  withConfigMutationExclusive: (run: (config: OpenClawConfig) => Promise<unknown>) =>
    run(mocks.config),
  transformConfigFileWithRetry: async ({
    transform,
    writeOptions,
  }: {
    transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig };
    writeOptions: { beforeCommit?: () => void };
  }) => {
    const { nextConfig } = transform(mocks.config);
    writeOptions.beforeCommit?.();
    mocks.publish(nextConfig);
    mocks.config = nextConfig;
  },
}));

let directory: string;
let request: Parameters<typeof restoreRetainedPostgresRoster>[0];

beforeEach(() => {
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "retained-roster-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  mocks.config = { agents: { entries: { main: { name: "Main" } } } };
  mocks.inspect.mockImplementation(async ({ agentId }: { agentId: string }) => ({
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    agentSchemaMeta: { role: "agent", agentId, schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION },
  }));
  request = {
    agents: ["first", "second"].map((agentId) => {
      const workspace = path.join(directory, "workspaces", agentId);
      const agentDir = path.join(directory, "agents", agentId, "agent");
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "openclaw-agent.sqlite"), "synthetic anchor");
      return { agentId, name: agentId, workspace, storeId: agentId, schema: `store_${agentId}` };
    }),
    assertCurrent: vi.fn(),
    writeOptions: {},
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("retained PostgreSQL roster", () => {
  it("admits two exact stores, publishes once and replays without another write", async () => {
    const first = await restoreRetainedPostgresRoster(request);
    expect(first.published).toBe(true);
    expect(mocks.inspect.mock.calls.map(([input]) => input.expectedPostgresIdentity)).toEqual([
      { storeId: "first", namespace: "store_first" },
      { storeId: "second", namespace: "store_second" },
    ]);
    expect(mocks.config.agents?.entries).toMatchObject({ first: {}, second: {}, main: {} });
    expect(await restoreRetainedPostgresRoster(request)).toEqual({ ...first, published: false });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes nothing when admission of a later agent fails", async () => {
    mocks.inspect.mockImplementation(async ({ agentId }) => {
      if (agentId === "second") {
        throw new Error("wrong store");
      }
      return {
        version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agentSchemaMeta: { agentId, role: "agent", schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION },
      };
    });
    await expect(restoreRetainedPostgresRoster(request)).rejects.toThrow("wrong store");
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("resumes tombstone settlement after publication without changing config", async () => {
    const agent = request.agents[1];
    const agentDir = path.join(directory, "agents", agent.agentId, "agent");
    const journal = {
      agentDir,
      workspaceDir: agent.workspace,
      databasePaths: [path.join(agentDir, "openclaw-agent.sqlite")],
      cleanupCompleted: true,
      deleteFiles: false,
      operationId: "retained-delete",
    };
    mocks.journal.mockImplementation(async (id: string) =>
      id === agent.agentId ? journal : undefined,
    );
    mocks.settle
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error("interrupted after commit"));
    await expect(restoreRetainedPostgresRoster(request)).rejects.toThrow(
      "interrupted after commit",
    );
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(await restoreRetainedPostgresRoster(request)).toMatchObject({ published: false });
    expect(mocks.settle).toHaveBeenLastCalledWith(journal);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
