import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAgentDatabaseReaderRequest,
  decodeAgentDatabaseReaderRequest,
  encodeAgentDatabaseReaderRequest,
  hasDeletedAgentDatabases,
  isDeletedAgentDatabasePath,
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
} from "./agent-database-readers.js";

const agentDir = path.resolve("/state/agents/alpha/agent");
const databasePath = path.join(agentDir, "openclaw-agent.sqlite");

describe("agent database reader requests", () => {
  it("round-trips close, deletion, and revive requests and rejects foreign keys", () => {
    const close = { kind: "close" as const, candidates: [{ path: databasePath }], deleted: false };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(close))).toEqual(
      close,
    );
    const deleted = { ...close, deleted: true };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(deleted))).toEqual(
      deleted,
    );
    const revive = { kind: "revive" as const, agentDirs: [agentDir] };
    expect(decodeAgentDatabaseReaderRequest(encodeAgentDatabaseReaderRequest(revive))).toEqual(
      revive,
    );
    expect(
      decodeAgentDatabaseReaderRequest(
        JSON.stringify([{ path: databasePath, scope: "sibling-family" }]),
      ),
    ).toEqual({
      kind: "close",
      candidates: [{ path: databasePath, scope: "sibling-family" }],
      deleted: false,
    });
    expect(decodeAgentDatabaseReaderRequest(undefined)).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest("state:identity")).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest(JSON.stringify({ other: [] }))).toBeUndefined();
    expect(decodeAgentDatabaseReaderRequest(JSON.stringify([{ path: 1 }]))).toBeUndefined();
  });

  it("runs every registered closer and keeps deleted databases closed until revived", async () => {
    const seen: string[][] = [];
    const unregister = registerAgentDatabaseReaderCloser((candidates) => {
      seen.push(candidates.map((candidate) => candidate.path));
    });
    try {
      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: databasePath }],
        deleted: false,
      });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);

      await applyAgentDatabaseReaderRequest({
        kind: "close",
        candidates: [{ path: databasePath }],
        deleted: true,
      });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      expect(hasDeletedAgentDatabases()).toBe(true);
      expect(isDeletedAgentDatabasePath(path.join(agentDir, "other.sqlite"))).toBe(false);
      expect(seen).toEqual([[databasePath], [databasePath]]);

      await applyAgentDatabaseReaderRequest({ kind: "revive", agentDirs: ["/state/agents/beta"] });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(true);
      await applyAgentDatabaseReaderRequest({ kind: "revive", agentDirs: [agentDir] });
      expect(isDeletedAgentDatabasePath(databasePath)).toBe(false);
      expect(hasDeletedAgentDatabases()).toBe(false);
      expect(seen).toHaveLength(2);
    } finally {
      unregister();
    }
  });

  it("surfaces closer failures after running the remaining closers", async () => {
    const calls: string[] = [];
    const unregisterFailing = registerAgentDatabaseReaderCloser(() => {
      calls.push("failing");
      throw new Error("reader close failed");
    });
    const unregisterHealthy = registerAgentDatabaseReaderCloser(() => {
      calls.push("healthy");
    });
    try {
      await expect(
        applyAgentDatabaseReaderRequest({
          kind: "close",
          candidates: [{ path: databasePath }],
          deleted: false,
        }),
      ).rejects.toThrow("reader close failed");
      expect(calls).toEqual(["failing", "healthy"]);
    } finally {
      unregisterFailing();
      unregisterHealthy();
    }
  });

  it("matches exact and sibling-family candidates only", () => {
    const sibling = path.join(agentDir, "openclaw-agent.memory.sqlite");
    expect(matchesAgentDatabaseReadCandidatePath({ path: databasePath }, databasePath)).toBe(true);
    expect(matchesAgentDatabaseReadCandidatePath({ path: databasePath }, sibling)).toBe(false);
    expect(
      matchesAgentDatabaseReadCandidatePath(
        { path: databasePath, scope: "sibling-family" },
        sibling,
      ),
    ).toBe(true);
    expect(
      matchesAgentDatabaseReadCandidatePath(
        { path: databasePath, scope: "sibling-family" },
        path.join(agentDir, "unrelated.sqlite"),
      ),
    ).toBe(false);
  });
});
