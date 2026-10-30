import { afterEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { createDoctorOriginalCaptureHook } from "./doctor-original-capture-admission.js";

const mocks = vi.hoisted(() => ({ preserve: vi.fn(), assertOwnerCurrent: vi.fn(), scope: true }));
// mock-isolation: Verify capture selection while leaving real maintenance acquisition to its owner suite.
vi.mock("./doctor-original-capture.js", () => ({ preserveDoctorOriginalState: mocks.preserve }));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  getOpenClawDatabaseMaintenanceScope: () =>
    mocks.scope ? { assertOwnerCurrent: mocks.assertOwnerCurrent } : undefined,
}));
afterEach(() => {
  vi.clearAllMocks();
  mocks.scope = true;
});

it("preserves the original state by default", async () => {
  mocks.preserve.mockResolvedValue({ findings: [], warnings: [] });
  const reportFindings = vi.fn();
  await createDoctorOriginalCaptureHook({
    root: null,
    runtime: defaultRuntime,
    json: true,
    reportFindings,
  })({ env: {}, signal: new AbortController().signal });
  expect(mocks.preserve).toHaveBeenCalledOnce();
  expect(reportFindings).toHaveBeenCalledWith([], []);
});

it("omits recovery capture only when explicitly selected under a current maintenance owner", async () => {
  await createDoctorOriginalCaptureHook({
    root: null,
    runtime: defaultRuntime,
    json: true,
    skipRecoveryBackups: true,
    reportFindings: vi.fn(),
  })({ env: {}, signal: new AbortController().signal });
  expect(mocks.assertOwnerCurrent).toHaveBeenCalledOnce();
  expect(mocks.preserve).not.toHaveBeenCalled();
});

it("does not turn skipped recovery capture into maintenance authority", async () => {
  mocks.scope = false;
  await expect(
    createDoctorOriginalCaptureHook({
      root: null,
      runtime: defaultRuntime,
      skipRecoveryBackups: true,
      reportFindings: vi.fn(),
    })({ env: {}, signal: new AbortController().signal }),
  ).rejects.toThrow("admitted maintenance scope");
  expect(mocks.preserve).not.toHaveBeenCalled();
});
