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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses to publish admission after the retired database cleanup owner expires", async () => {
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
  } finally {
    retireSqliteDatabaseAdmissionForPath(location);
    await applyAgentDatabaseReaderRequest({ kind: "revive", agentIds: [agentId] });
  }
});
