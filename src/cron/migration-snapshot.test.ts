import { describe, expect, it } from "vitest";
import { parseCronMigrationSnapshot } from "./migration-snapshot.js";
import type { CronStoredJob } from "./types.js";

const job: CronStoredJob = {
  id: "job-a",
  agentId: "alpha",
  name: "job-a",
  enabled: true,
  createdAtMs: 10,
  updatedAtMs: 20,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Check the weather" },
  state: { nextRunAtMs: 60123 },
};
const scratch = {
  jobId: "job-a",
  content: "notes",
  revision: 1,
  sourceSha256: null,
  updatedAtMs: 5,
};
const base = {
  version: 1,
  operationId: "move",
  agentIds: ["alpha"],
  jobs: [job],
  scratch: [scratch],
};

describe("parseCronMigrationSnapshot", () => {
  it("accepts a well-formed snapshot and normalizes scope and retained IDs", () => {
    expect(
      parseCronMigrationSnapshot({
        ...base,
        agentIds: ["beta", "alpha"],
        retainedJobIds: ["z", "b"],
      }),
    ).toEqual({ ...base, agentIds: ["alpha", "beta"], retainedJobIds: ["b", "z"] });
    expect(parseCronMigrationSnapshot(base)).not.toHaveProperty("retainedJobIds");
  });

  it.each([
    ["a non-object", "nope", /unknown or missing/],
    ["an unknown field", { ...base, extra: true }, /unknown or missing/],
    ["a missing field", { ...base, scratch: undefined }, /scratch must be an array/],
    ["an unsupported version", { ...base, version: 2 }, /unsupported version/],
    ["a malformed operationId", { ...base, operationId: "bad id" }, /operationId/],
    ["an empty scope", { ...base, agentIds: [] }, /nonempty agentIds/],
    ["a non-object job", { ...base, jobs: ["job-a"] }, /each job must be an object/],
    [
      "a job without a schedule",
      { ...base, jobs: [{ ...job, schedule: undefined }] },
      /not persistable/,
    ],
    [
      "a job with an invalid state timestamp",
      { ...base, jobs: [{ ...job, state: { nextRunAtMs: "soon" } }] },
      /not persistable/,
    ],
    ["duplicate job IDs", { ...base, jobs: [job, job] }, /unique/],
    [
      "scratch with an extra field",
      { ...base, scratch: [{ ...scratch, note: 1 }] },
      /scratch entries carry only/,
    ],
    [
      "scratch for a job outside the snapshot",
      { ...base, scratch: [{ ...scratch, jobId: "other" }] },
      /distinct snapshot job/,
    ],
    [
      "scratch with a zero revision",
      { ...base, scratch: [{ ...scratch, revision: 0 }] },
      /invalid field/,
    ],
    [
      "scratch with a malformed digest",
      { ...base, scratch: [{ ...scratch, sourceSha256: "abc" }] },
      /invalid field/,
    ],
    ["retained IDs that overlap jobs", { ...base, retainedJobIds: ["job-a"] }, /retainedJobIds/],
    ["duplicate retained IDs", { ...base, retainedJobIds: ["x", "x"] }, /retainedJobIds/],
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseCronMigrationSnapshot(value)).toThrow(message);
  });

  it("rejects a snapshot over the transfer limit", () => {
    const oversized = {
      ...base,
      jobs: [{ ...job, payload: { kind: "agentTurn", message: "x".repeat(8 * 1024 * 1024) } }],
      scratch: [],
    };
    expect(() => parseCronMigrationSnapshot(oversized)).toThrow(/8 MiB/);
  });
});
