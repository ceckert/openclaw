import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteDatabaseAdmissions } from "./sqlite-database-admission-record.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

const boundary = vi.hoisted(() => {
  const port: unknown = undefined;
  return { port, closeMemory: vi.fn(), environment: new Map<unknown, unknown>() };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get parentPort() {
    return boundary.port;
  },
  threadId: 1,
  getEnvironmentData: (key: unknown) => boundary.environment.get(key),
  setEnvironmentData: (key: unknown, value: unknown) => boundary.environment.set(key, value),
}));
// mock-isolation: Each synthetic worker gets isolate-local registries, not the test process's state.
vi.mock("../shared/global-singleton.js", () => ({
  resolveGlobalSingleton: <T>(_key: symbol, create: () => T): T => create(),
  resolveGlobalMap: <K, V>() => new Map<K, V>(),
  resolveGlobalSet: <T>() => new Set<T>(),
  readGlobalSingleton: () => undefined,
  drainGlobalSingletonLifecycleState: async () => {},
}));
// mock-isolation: Do not initialize process-wide logging for the worker protocol fixture.
vi.mock("../logging/state.js", () => ({ loggingState: {} }));
// mock-isolation: Admission imports publication diagnostics, not the logging/config runtime.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: vi.fn() }),
}));
// mock-isolation: Observe diagnostic cleanup without allocating a memory transport.
vi.mock("./worker-memory.js", () => ({ serveWorkerMemorySamples: () => boundary.closeMemory }));
// mock-isolation: Keep process-wide idle timers outside the retirement fixture.
vi.mock("./worker-idle-gc.js", () => ({
  cancelWorkerIdleGc: vi.fn(),
  scheduleWorkerIdleGc: vi.fn(),
}));
const exitCode = process.exitCode;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boundary.closeMemory.mockReset();
  boundary.environment.clear();
});
afterEach(() => {
  process.exitCode = exitCode;
});

function taskContext(databaseAdmissionPort?: MessagePort): WorkerTaskContext {
  return {
    deletedAgentDatabaseFences: [],
    ...(databaseAdmissionPort ? { databaseAdmissionPort } : {}),
  };
}

// Answer on the real reply port before publishing the native completion flag; no worker or timer.
function acknowledgeAdmissionExchanges(port: MessagePort) {
  return vi.spyOn(port, "postMessage").mockImplementation((message: unknown) => {
    // SAFETY: Only the production admission relay writes this private fixture port.
    const request = message as {
      admissions: SqliteDatabaseAdmissions;
      port: MessagePort;
      decision: SharedArrayBuffer;
    };
    request.port.postMessage(request.admissions, []);
    Atomics.store(new Int32Array(request.decision), 0, 1);
  });
}

it.each([false, true])(
  "joins task cleanup and queued receipts before retiring admission transport (diagnostic failure: %s)",
  async (diagnosticFailure) => {
    const closed = createDeferred<string>();
    const result = createDeferred<string>();
    const entered = createDeferred();
    const cleanup = createDeferred();
    const port = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(() => result.resolve("result")),
      close: vi.fn(() => closed.resolve("closed")),
    });
    boundary.port = port;
    const { port1: admissionPort, port2: admissionPeer } = new MessageChannel();
    const closeAdmission = vi.spyOn(admissionPort, "close");
    const exchanges = acknowledgeAdmissionExchanges(admissionPort);
    const { serveOwnedWorkerTasks } = await import("./worker-task-server.js");
    const { hasSqliteDatabaseSchemaAdmissionForPath } =
      await import("./sqlite-database-admission.js");
    const { getSqliteDatabaseAdmissionUpstream } =
      await import("./sqlite-worker-database-admission-relay.js");
    const { cancelWorkerIdleGc, scheduleWorkerIdleGc } = await import("./worker-idle-gc.js");
    const closeResource = vi.fn();
    const handler = vi.fn(async () => {
      try {
        throw new Error("uncertain native close");
      } finally {
        entered.resolve();
        await cleanup.promise;
        hasSqliteDatabaseSchemaAdmissionForPath(":memory:");
      }
    });
    const receipt = { postMessage: vi.fn(), close: vi.fn() };
    boundary.closeMemory.mockImplementation(() => {
      if (diagnosticFailure) {
        throw new Error("memory diagnostic cleanup failed");
      }
    });
    try {
      serveOwnedWorkerTasks(handler, { retireOnError: true, closeResource });
      port.emit("message", {
        taskId: 1,
        nativeSections: new SharedArrayBuffer(4),
        taskContext: taskContext(admissionPort),
        sampleMemory: true,
      });
      await entered.promise;
      expect(getSqliteDatabaseAdmissionUpstream()).toEqual({ port: admissionPort, closed: false });
      port.emit("message", { closeResource: true, resourcePort: receipt });
      expect(port.close).not.toHaveBeenCalled();
      expect(closeAdmission).not.toHaveBeenCalled();
      expect(boundary.closeMemory).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
      cleanup.resolve();
      expect(await Promise.race([closed.promise, result.promise])).toBe("closed");
      expect(exchanges).toHaveBeenCalledOnce();
      expect(receipt.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), []);
      expect(receipt.close).toHaveBeenCalledOnce();
      expect(closeResource).not.toHaveBeenCalled();
      expect(boundary.closeMemory).toHaveBeenCalledOnce();
      expect(closeAdmission).toHaveBeenCalledOnce();
      expect(port.close).toHaveBeenCalledOnce();
      expect(receipt.close).toHaveBeenCalledBefore(boundary.closeMemory);
      expect(boundary.closeMemory).toHaveBeenCalledBefore(closeAdmission);
      expect(closeAdmission).toHaveBeenCalledBefore(port.close);
      expect(cancelWorkerIdleGc).toHaveBeenCalledTimes(3);
      expect(scheduleWorkerIdleGc).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      port.emit("message", { taskId: 2 });
      expect(handler).toHaveBeenCalledOnce();
      expect(port.postMessage).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      admissionPort.close();
      admissionPeer.close();
    }
  },
);

it("keeps ordinary task errors reusable", async () => {
  let result = createDeferred();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve()),
    close: vi.fn(),
  });
  boundary.port = port;
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  const handler = vi.fn<() => string>();
  handler.mockImplementationOnce(() => {
    throw new Error("ordinary failure");
  });
  handler.mockReturnValue("next task");
  serveWorkerTasks(handler);
  port.emit("message", {
    taskId: 1,
    nativeSections: new SharedArrayBuffer(4),
    taskContext: taskContext(),
  });
  await result.promise;
  expect(port.postMessage).toHaveBeenCalledWith({
    status: "failed",
    taskId: 1,
    error: "ordinary failure",
  });
  result = createDeferred();
  port.emit("message", {
    taskId: 2,
    nativeSections: new SharedArrayBuffer(4),
    taskContext: taskContext(),
  });
  await result.promise;
  expect(port.postMessage).toHaveBeenLastCalledWith(
    { status: "ok", value: "next task", taskId: 2 },
    [],
  );
  expect(handler).toHaveBeenCalledTimes(2);
  expect(port.close).not.toHaveBeenCalled();
  expect(boundary.closeMemory).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCode);
});

it("retains admission context for asynchronous resource cleanup and successor tasks", async () => {
  let result = createDeferred();
  const cleanupEntered = createDeferred();
  const finishCleanup = createDeferred();
  const receiptClosed = createDeferred();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve()),
    close: vi.fn(),
  });
  boundary.port = port;
  const { port1: admissionPort, port2: admissionPeer } = new MessageChannel();
  const closeAdmission = vi.spyOn(admissionPort, "close");
  const exchanges = acknowledgeAdmissionExchanges(admissionPort);
  const { serveOwnedWorkerTasks } = await import("./worker-task-server.js");
  const { hasSqliteDatabaseSchemaAdmissionForPath } =
    await import("./sqlite-database-admission.js");
  const { registerAgentDatabaseReaderCloser, isDeletedAgentDatabasePath } =
    await import("./agent-database-readers.js");
  const { getSqliteDatabaseAdmissionUpstream } =
    await import("./sqlite-worker-database-admission-relay.js");
  const unregister = registerAgentDatabaseReaderCloser(async () => {
    cleanupEntered.resolve();
    await finishCleanup.promise;
    hasSqliteDatabaseSchemaAdmissionForPath(":memory:");
  });
  const closeResource = vi.fn(() => {
    hasSqliteDatabaseSchemaAdmissionForPath(":memory:");
  });
  const handler = vi.fn(() => {
    hasSqliteDatabaseSchemaAdmissionForPath(":memory:");
    return "done";
  });
  const receipt = {
    postMessage: vi.fn(),
    close: vi.fn(() => receiptClosed.resolve()),
  };
  try {
    serveOwnedWorkerTasks(handler, { closeResource });
    port.emit("message", {
      taskId: 1,
      nativeSections: new SharedArrayBuffer(4),
      taskContext: {
        ...taskContext(admissionPort),
        deletedAgentDatabaseFences: [["/synthetic/retired-agent.sqlite", "retired-agent"]],
      } satisfies WorkerTaskContext,
    });
    await result.promise;
    expect(isDeletedAgentDatabasePath("/synthetic/retired-agent.sqlite")).toBe(true);
    expect(exchanges).toHaveBeenCalledOnce();
    port.emit("message", { closeResource: true, key: "[]", resourcePort: receipt });
    await cleanupEntered.promise;
    expect(receipt.postMessage).not.toHaveBeenCalled();
    expect(closeAdmission).not.toHaveBeenCalled();
    result = createDeferred();
    port.emit("message", {
      taskId: 2,
      nativeSections: new SharedArrayBuffer(4),
      taskContext: taskContext(),
    });
    expect(handler).toHaveBeenCalledOnce();
    finishCleanup.resolve();
    await receiptClosed.promise;
    await result.promise;
    expect(receipt.postMessage).toHaveBeenCalledWith({ ok: true }, []);
    expect(closeResource).toHaveBeenCalledExactlyOnceWith("[]");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(exchanges).toHaveBeenCalledTimes(4);
    expect(getSqliteDatabaseAdmissionUpstream()).toEqual({ port: admissionPort, closed: false });
    expect(isDeletedAgentDatabasePath("/synthetic/retired-agent.sqlite")).toBe(false);
    admissionPeer.postMessage("still open", []);
    expect(receiveMessageOnPort(admissionPort)?.message).toBe("still open");
    expect(closeAdmission).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  } finally {
    finishCleanup.resolve();
    unregister();
    admissionPort.close();
    admissionPeer.close();
  }
});

it("closes native maintenance loaded by a completed task under the cleanup admission", async () => {
  vi.useFakeTimers();
  const result = createDeferred();
  const idleComplete = createDeferred();
  let idleError: unknown;
  const receiptClosed = createDeferred();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve()),
    close: vi.fn(),
  });
  boundary.port = port;
  const { port1: admissionPort, port2: admissionPeer } = new MessageChannel();
  const exchanges = acknowledgeAdmissionExchanges(admissionPort);
  const { serveOwnedWorkerTasks } = await import("./worker-task-server.js");
  const { hasSqliteDatabaseSchemaAdmissionForPath, prepareSqliteDatabaseAdmission } =
    await import("./sqlite-database-admission.js");
  let maintenance: typeof import("./sqlite-wal.js").runInSqliteMaintenanceContext;
  let expiredTask: ReturnType<typeof AsyncLocalStorage.snapshot>;
  const closeResource = () => {
    maintenance(() => hasSqliteDatabaseSchemaAdmissionForPath(":memory:"));
  };
  const receipt = {
    postMessage: vi.fn(),
    close: vi.fn(() => receiptClosed.resolve()),
  };
  try {
    serveOwnedWorkerTasks(
      async () => {
        ({ runInSqliteMaintenanceContext: maintenance } = await import("./sqlite-wal.js"));
        expiredTask = AsyncLocalStorage.snapshot();
        // The fake clock lacks Node timer resources; bind the scheduled callback's native context.
        maintenance(() =>
          setTimeout(
            AsyncLocalStorage.bind(() => {
              try {
                hasSqliteDatabaseSchemaAdmissionForPath(":memory:");
              } catch (error) {
                idleError = error;
              } finally {
                idleComplete.resolve();
              }
            }),
            10,
          ),
        );
        return "loaded";
      },
      { closeResource },
    );
    port.emit("message", {
      taskId: 1,
      nativeSections: new SharedArrayBuffer(4),
      taskContext: taskContext(admissionPort),
    });
    await result.promise;
    expect(port.postMessage).toHaveBeenCalledWith({ status: "ok", value: "loaded", taskId: 1 }, []);
    expect(() => expiredTask(() => hasSqliteDatabaseSchemaAdmissionForPath(":memory:"))).toThrow(
      "SQLite admission facts outlived their worker task",
    );
    await vi.advanceTimersByTimeAsync(10);
    await idleComplete.promise;
    expect(idleError).toBeUndefined();
    port.emit("message", { closeResource: true, key: "[]", resourcePort: receipt });
    await receiptClosed.promise;
    expect(receipt.postMessage).toHaveBeenCalledWith({ ok: true }, []);
    expect(exchanges).toHaveBeenCalledTimes(2);
    expect(port.close).not.toHaveBeenCalled();
    const newDatabase = path.join(tempDirs.make("worker-maintenance-admission-"), "new.sqlite");
    expect(() =>
      maintenance(() => prepareSqliteDatabaseAdmission(newDatabase, { create: true })),
    ).toThrow("SQLite maintenance cannot create databases");
    expect(existsSync(newDatabase)).toBe(false);
    expect(exchanges).toHaveBeenCalledTimes(2);
    const closed = once(admissionPort, "close");
    admissionPort.close();
    await closed;
    expect(() => maintenance(() => hasSqliteDatabaseSchemaAdmissionForPath(":memory:"))).toThrow(
      "SQLite admission upstream is closed",
    );
  } finally {
    vi.useRealTimers();
    admissionPort.close();
    admissionPeer.close();
  }
});
