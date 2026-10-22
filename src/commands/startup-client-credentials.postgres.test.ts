import "../test-utils/prepare-compiled-subprocesses.js";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { readDeviceAuthTokenForTest } from "../infra/device-auth-store.test-support.js";
import {
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { prepareStartupClientCredentials } from "./startup-client-credentials.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const namespaces = new Set<string>();
afterAll(async () => {
  if (!connection || namespaces.size === 0) {
    return;
  }
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
  } finally {
    await client.end();
  }
});

describe.skipIf(!connection)("PostgreSQL client credential startup preparation", () => {
  const dirs = useStateDatabaseTempDirs();
  // This isolated process drives `openclaw doctor --client-credentials`, a CLI one-shot.
  beforeAll(() => installDatabaseProcessRole("cli-oneshot"));
  const missingMessage =
    "Local credentials are missing; restore the matching client credential backup.";

  async function bootstrap() {
    const root = fs.realpathSync(dirs.make("credential-rebind-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_PROFILE: "default",
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const config = {
      database: {
        families: { state: { engine: "postgres" as const } },
        postgres: { connection: connection!, schemaPrefix: "credential_rebind" },
      },
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
    withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: config.database.postgres,
      },
      () =>
        withEngineStoreAdmission(() => {
          const state = openOpenClawStateDatabase({ env });
          namespaces.add(getPostgresPhysicalFacts(state.db)!.namespace);
        }),
    );
    await closeOpenClawStateDatabaseAsync();
    const anchor = path.join(root, "state", "openclaw.sqlite");
    const local = resolveClientCredentialStorePath(env);
    expect(fs.existsSync(local)).toBe(true);
    const storeId = (() => {
      using database = new DatabaseSync(anchor, { readOnly: true });
      return String(
        database.prepare("SELECT store_id FROM openclaw_engine_anchor").get()?.store_id,
      );
    })();
    return { root, env, anchor, local, storeId };
  }

  /** A replacement pod's process re-creates the state anchor as a new file. */
  async function replaceAnchor(anchor: string) {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const replacement = `${anchor}.replacement`;
    fs.copyFileSync(anchor, replacement);
    fs.renameSync(replacement, anchor);
  }

  async function replacementPod() {
    const fixture = await bootstrap();
    fs.rmSync(path.dirname(fixture.local), { recursive: true });
    await replaceAnchor(fixture.anchor);
    return fixture;
  }

  function readReceipt(env: NodeJS.ProcessEnv) {
    using owner = openClientCredentialCustody(env, { readOnly: true, migration: true });
    return owner && readClientCredentialReceipt(owner.database);
  }

  function runtime(error = vi.fn()) {
    return {
      error,
      runtime: {
        log() {},
        error,
        exit(code: number) {
          throw new Error(`Unexpected startup exit ${code}`);
        },
      },
    };
  }

  it("refuses missing local credentials without the rebind opt-in", async () => {
    const fixture = await replacementPod();
    await expect(
      prepareStartupClientCredentials({ env: fixture.env, runtime: runtime().runtime }),
    ).rejects.toThrow(missingMessage);
    expect(fs.existsSync(fixture.local)).toBe(false);
  });

  it("binds a fresh local store to the existing PostgreSQL state store when opted in", async () => {
    const fixture = await replacementPod();
    const output = runtime();
    await prepareStartupClientCredentials({
      env: fixture.env,
      rebindMissing: true,
      runtime: output.runtime,
    });
    expect(readReceipt(fixture.env)).toMatchObject({
      phase: "complete",
      receipt: {
        source: {
          kind: "canonical",
          engine: "postgres",
          identity: fixture.storeId,
          generation: `bootstrap:${fixture.storeId}`,
          destinationVersion: 1,
        },
        sharedFile: readClientCredentialFileIdentity(fixture.anchor),
      },
    });
    expect(output.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /re-created.*Clients on this host have new device identities and must pair again; devices that kept their own credentials stay paired\./u,
      ),
    );
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toBeNull();
    expect(loadOrCreateDeviceIdentity({ env: fixture.env }).deviceId).toBeTruthy();
  });

  it("keeps retained legacy credential files out of a rebound store", async () => {
    const fixture = await replacementPod();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyPem)!;
    const identityDir = path.join(fixture.root, "identity");
    const retained = {
      "device.json": JSON.stringify({
        version: 1,
        deviceId,
        publicKeyPem,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
        createdAtMs: 1,
      }),
      "device-auth.json": JSON.stringify({
        version: 1,
        deviceId,
        tokens: {
          operator: { token: "retired-token", role: "operator", scopes: [], updatedAtMs: 1 },
        },
      }),
    };
    fs.mkdirSync(identityDir, { recursive: true });
    for (const [filename, raw] of Object.entries(retained)) {
      fs.writeFileSync(path.join(identityDir, filename), raw);
    }
    await prepareStartupClientCredentials({
      env: fixture.env,
      rebindMissing: true,
      runtime: runtime().runtime,
    });
    await prepareStartupClientCredentials({ env: fixture.env, runtime: runtime().runtime });
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toBeNull();
    expect(readDeviceAuthTokenForTest({ deviceId, role: "operator", env: fixture.env })).toBeNull();
    for (const [filename, raw] of Object.entries(retained)) {
      expect(fs.readFileSync(path.join(identityDir, filename), "utf8")).toBe(raw);
    }
  });

  it("refuses present credentials bound to another store even when opted in", async () => {
    const fixture = await bootstrap();
    {
      using owner = openClientCredentialCustody(fixture.env, { migration: true })!;
      const stored = readClientCredentialReceipt(owner.database)!;
      stored.receipt.source!.identity = "another-postgres-store";
      owner.transaction(() =>
        writeClientCredentialReceipt(owner.database, stored.receipt, stored.phase),
      );
    }
    await replaceAnchor(fixture.anchor);
    const before = fs.readFileSync(fixture.local);
    await expect(
      prepareStartupClientCredentials({
        env: fixture.env,
        rebindMissing: true,
        runtime: runtime().runtime,
      }),
    ).rejects.toThrow(
      "Local credentials do not match the shared database; restore their matched backup.",
    );
    expect(fs.readFileSync(fixture.local)).toEqual(before);
  });

  it("keeps a rebound store on the normal path for later boots and anchor replacement", async () => {
    const fixture = await replacementPod();
    await prepareStartupClientCredentials({
      env: fixture.env,
      rebindMissing: true,
      runtime: runtime().runtime,
    });
    const identity = loadOrCreateDeviceIdentity({ env: fixture.env });
    const bytes = fs.readFileSync(fixture.local);
    const later = runtime();
    await prepareStartupClientCredentials({ env: fixture.env, runtime: later.runtime });
    expect(fs.readFileSync(fixture.local)).toEqual(bytes);
    await replaceAnchor(fixture.anchor);
    await prepareStartupClientCredentials({ env: fixture.env, runtime: later.runtime });
    expect(later.error).not.toHaveBeenCalled();
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(identity);
    expect(readReceipt(fixture.env)?.receipt).toMatchObject({
      source: { identity: fixture.storeId },
      sharedFile: readClientCredentialFileIdentity(fixture.anchor),
    });
  });
});
