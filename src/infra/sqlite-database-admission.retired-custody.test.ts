import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyAgentDatabaseReaderRequest } from "./agent-database-readers.js";
import {
  getSqliteDatabaseAdmissionIdentityForPath,
  prepareSqliteDatabaseAdmissionAsync,
  retireSqliteDatabaseAdmissionForPath,
} from "./sqlite-database-admission.js";
import { prepareSqliteWorkerDatabaseAdmission } from "./sqlite-worker-broker-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withRetiredDatabase(run: (location: string, agentId: string) => Promise<void>) {
  const agentId = "retired-custody";
  const location = path.join(tempDirs.make("sqlite-retired-custody-"), "agent.sqlite");
  {
    using db = new DatabaseSync(location);
    db.exec("CREATE TABLE proof(value integer)");
  }
  await applyAgentDatabaseReaderRequest({
    kind: "close",
    deleted: true,
    agentId,
    candidates: [{ path: location }],
  });
  try {
    await run(location, agentId);
  } finally {
    retireSqliteDatabaseAdmissionForPath(location);
    await applyAgentDatabaseReaderRequest({ kind: "revive", agentIds: [agentId] });
  }
}

it("refuses to publish admission after the retired database cleanup owner expires", async () => {
  await withRetiredDatabase(async (location, agentId) => {
    const assertCustody = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("Cleanup owner expired");
      });
    const params = { location, assertCurrent() {} };
    await expect(
      prepareSqliteDatabaseAdmissionAsync({
        ...params,
        retiredAgentCustody: { agentId, assertCurrent: assertCustody },
      }),
    ).rejects.toThrow("Cleanup owner expired");
    expect(getSqliteDatabaseAdmissionIdentityForPath(location)).toBeUndefined();
    await expect(prepareSqliteDatabaseAdmissionAsync(params)).resolves.toBeUndefined();
  });
});

it("admits a retired database through the worker broker only with its matching live custody", async () => {
  await withRetiredDatabase(async (databasePath, agentId) => {
    const moduleUrl = new URL(import.meta.url);
    const options = {
      databasePath,
      moduleUrl,
      carrierUrl: moduleUrl,
      input: Buffer.alloc(0),
      existingOnly: true,
    };
    const assertCurrent = vi.fn();
    await expect(prepareSqliteWorkerDatabaseAdmission(options)).rejects.toThrow();
    await expect(
      prepareSqliteWorkerDatabaseAdmission({
        ...options,
        retiredAgentCustody: { agentId, assertCurrent },
      }),
    ).resolves.toMatchObject({ databasePath });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    await expect(prepareSqliteWorkerDatabaseAdmission(options)).rejects.toThrow();
  });
});
