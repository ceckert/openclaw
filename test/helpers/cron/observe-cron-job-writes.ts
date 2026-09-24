// Observes committed cron job marker writes from the host connection and from state-worker commits.
import { vi } from "vitest";
import * as cronStore from "../../../src/cron/store.js";
import { cronStoreKey } from "../../../src/cron/store/key.js";
import { openOpenClawStateDatabase } from "../../../src/state/openclaw-state-db.js";

export type ObservedCronJobMarkers = { queuedAtMs?: number; runningAtMs?: number };

let observerId = 0;

function markersFromStateJson(stateJson: unknown): ObservedCronJobMarkers {
  if (typeof stateJson !== "string") {
    return {};
  }
  const state = JSON.parse(stateJson) as ObservedCronJobMarkers;
  return {
    ...(typeof state.queuedAtMs === "number" ? { queuedAtMs: state.queuedAtMs } : {}),
    ...(typeof state.runningAtMs === "number" ? { runningAtMs: state.runningAtMs } : {}),
  };
}

/**
 * Host-thread writes are observed inside their transaction through a
 * connection-local trigger. Reservation writes commit in the state worker's
 * connection, where that trigger cannot fire; they are observed on the host
 * immediately after commit, when the worker's outcome is published, and only
 * when the committed markers differ from the last observed ones.
 */
export function observeCronJobWrites(
  target: { storePath: string; jobId: string },
  observer: (state: ObservedCronJobMarkers) => void,
): () => void {
  const database = openOpenClawStateDatabase().db;
  const storeKey = cronStoreKey(target.storePath);
  const suffix = ++observerId;
  const functionName = `observe_cron_job_write_${suffix}`;
  const triggerName = `observe_cron_job_write_${suffix}`;
  let lastObserved: string | undefined;
  const report = (markers: ObservedCronJobMarkers) => {
    lastObserved = JSON.stringify(markers);
    observer(markers);
  };
  database.function(functionName, (writtenJobId, stateJson) => {
    if (writtenJobId !== target.jobId) {
      return 0;
    }
    report(markersFromStateJson(stateJson));
    return 0;
  });
  database.exec(`
    CREATE TEMP TRIGGER ${triggerName}
    AFTER UPDATE ON cron_jobs
    BEGIN
      SELECT ${functionName}(NEW.job_id, NEW.state_json);
    END;
  `);
  const original = cronStore.noteCronJobsStoreCommit;
  const commitSpy = vi.spyOn(cronStore, "noteCronJobsStoreCommit").mockImplementation((key) => {
    original(key);
    if (key !== storeKey) {
      return;
    }
    const row = database
      .prepare("SELECT state_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
      .get(storeKey, target.jobId) as { state_json?: unknown } | undefined;
    if (!row) {
      return;
    }
    const markers = markersFromStateJson(row.state_json);
    if (JSON.stringify(markers) !== lastObserved) {
      report(markers);
    }
  });
  return () => {
    commitSpy.mockRestore();
    database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  };
}
