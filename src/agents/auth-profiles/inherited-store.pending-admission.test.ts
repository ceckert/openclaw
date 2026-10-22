import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createExternalAuthRuntime } from "./external-auth.js";
import { loadInheritedAuthProfileStore } from "./inherited-store.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { closeAuthProfileReadPool, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileStore } from "./types.js";

// The PostgreSQL agent-store reader borrows the agent database execution, whose admission
// capture rejects a refused owner before any rows exist. Stand in for that engine here.
vi.mock("./sqlite-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sqlite-read.js")>();
  const admission = await import("../../state/agent-database-admission.js");
  return {
    ...actual,
    prepareAgentAuthProfileRowsRead: (
      options: Parameters<typeof actual.prepareAgentAuthProfileRowsRead>[0],
    ) => {
      const reader = actual.prepareAgentAuthProfileRowsRead(options);
      return {
        get identity() {
          return reader.identity;
        },
        get source() {
          return reader.source;
        },
        captureCredentialAuthority: reader.captureCredentialAuthority,
        track: reader.track,
        assertCurrent: reader.assertCurrent,
        dispose: reader.dispose,
        read: async () => {
          const refusal = admission.readAgentDatabaseAdmissionRefusal(options.agentId, {
            env: options.env,
          });
          if (refusal) {
            throw new admission.AgentDatabaseAdmissionError(refusal);
          }
          return reader.read();
        },
      };
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createStore(profileId: string, key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key", provider: "custom", key } },
  };
}

let root: string;
let env: NodeJS.ProcessEnv;
let mainDir: string;
let workerDir: string;
beforeEach(() => {
  root = tempDirs.make("inherited-auth-pending-");
  env = { OPENCLAW_STATE_DIR: root };
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  mainDir = path.join(root, "agents/main/agent");
  workerDir = path.join(root, "agents/worker/agent");
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function persist(store: AuthProfileStore, agentId: string) {
  const database = openOpenClawAgentDatabase({ agentId, env });
  writePersistedAuthProfileStoreRaw(store, path.dirname(database.path), database);
  return database;
}

function recordPendingRefusal(agentId: string, databasePath: string) {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId,
    paths: [databasePath],
    pending: true,
    reason: `Agent ${agentId} has not completed startup inspection and preparation.`,
  });
  recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
  return refusal;
}

function createRuntime() {
  return createAuthProfileStoreRuntime(
    createExternalAuthRuntime(
      () => [],
      async (_params, run) => run(),
    ),
  );
}

const readOptions = {
  allowKeychainPrompt: false,
  readOnly: true,
  syncExternalCli: false,
  externalCli: { mode: "none" as const },
};

it.each(["runtime", "model-runtime"] as const)(
  "keeps local credentials while the inherited owner's admission is pending, then inherits after admission via %s",
  async (mode) => {
    vi.stubEnv("OPENCLAW_AGENT_DIR", mainDir);
    prepareSharedAuthStoreOwnershipForNative();
    const local = createStore("custom:local", "local-fixture");
    const inherited = createStore("custom:shared", "inherited-fixture");
    const mainPath = persist(inherited, "main").path;
    persist(local, "worker");
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    recordPendingRefusal("main", mainPath);
    const runtime = createRuntime();
    const read = () => {
      if (mode === "model-runtime") {
        const context = captureOpenClawStateWorkerContext({ env });
        return runtime.prepareAuthProfileStoreForModelRuntime(
          workerDir,
          { config: {}, inheritedAuthDir: mainDir },
          () => context.admission.assertCurrent(),
        );
      }
      return runtime.loadAuthProfileStoreForRuntimeAsync(workerDir, {
        ...readOptions,
        inheritedAuthDir: mainDir,
      });
    };
    expect((await read())?.profiles).toEqual(local.profiles);
    recordAgentDatabaseAdmissions([], { env, source: "startup" });
    expect((await read())?.profiles).toEqual({ ...inherited.profiles, ...local.profiles });
  },
);

it("still refuses the requested agent while its own admission is pending", async () => {
  vi.stubEnv("OPENCLAW_AGENT_DIR", mainDir);
  prepareSharedAuthStoreOwnershipForNative();
  persist(createStore("custom:shared", "inherited-fixture"), "main");
  const workerPath = persist(createStore("custom:local", "local-fixture"), "worker").path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  recordPendingRefusal("worker", workerPath);
  await expect(
    createRuntime().loadAuthProfileStoreForRuntimeAsync(workerDir, {
      ...readOptions,
      inheritedAuthDir: mainDir,
    }),
  ).rejects.toThrow(AgentDatabaseAdmissionError);
});

it("drops only the refused inherited owner's admission failure", () => {
  const mainPath = path.join(mainDir, "openclaw-agent.sqlite");
  const pendingMain = recordPendingRefusal("main", mainPath);
  const fail = (refusal: typeof pendingMain) => () => {
    throw new AgentDatabaseAdmissionError(refusal);
  };
  expect(loadInheritedAuthProfileStore(fail(pendingMain), mainDir, env)).toBeUndefined();
  const unrelated = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: [path.join(workerDir, "openclaw-agent.sqlite")],
    pending: true,
    reason: "Agent worker has not completed startup inspection and preparation.",
  });
  expect(() => loadInheritedAuthProfileStore(fail(unrelated), mainDir, env)).toThrow(
    AgentDatabaseAdmissionError,
  );
});
