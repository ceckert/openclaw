import { afterEach, expect, it, vi } from "vitest";
import { createDoctorHealthFlowContext } from "./doctor-health-context.test-support.js";
import { initialDoctorHealthContribution } from "./doctor-health-contributions-selection.test-support.js";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(async () => []) }));
// mock-isolation: Observe diagnostic inventory selection without connecting to operator databases.
vi.mock("../commands/doctor-database-engine.js", () => ({ noteDatabaseEngines: mocks.inspect }));
afterEach(() => vi.clearAllMocks());

it.each([false, true])(
  "keeps database readiness inventory optional for an externally managed PostgreSQL migration (skip=%s)",
  async (skipRecoveryBackups) => {
    const ctx = createDoctorHealthFlowContext({
      cfg: { database: { engine: "sqlite", families: { agent: { engine: "postgres" } } } },
      options: { skipRecoveryBackups },
    });
    await initialDoctorHealthContribution("doctor:database-engine").run(ctx);
    expect(mocks.inspect).toHaveBeenCalledTimes(skipRecoveryBackups ? 0 : 1);
  },
);
