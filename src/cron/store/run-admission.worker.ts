import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { retainManualOneShotOccurrence } from "../service/one-shot-schedule.js";
import {
  assertCronAgentMigrationAdmitted,
  CronAgentMigrationHeldError,
} from "./migration.kernel.js";
import { loadedCronStoreFromRows, loadCronRows, upsertCronJobRow } from "./row-codec.js";
import {
  adjudicateActiveCronRunReceiptInDatabase,
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./run-receipt-store.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import {
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function reserveCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.reserveRuns"]["input"],
): { nonce: string } {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const planned = new Map(input.candidates.map((job) => [job.id, job]));
      const rows = loadCronRows(db, input.storeKey, new Set(planned.keys()), {
        includeGrantDefinitionProjection: true,
      });
      const jobs = loadedCronStoreFromRows(rows).store.jobs;
      const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey: input.storeKey, jobs });
      if (repairJobIds.length) {
        repairCronRuntimeAuthorityRows({
          db,
          storeKey: input.storeKey,
          jobs,
          jobIds: repairJobIds,
        });
      }
      const preparation = prepareCronRuntimeMutation("cron.reserveRuns", input.nonce, {
        observed: input.candidates.map((job) => ({
          jobId: job.id,
          receipt: findActiveCronRunReceiptInDatabase({
            database: db,
            storePath: input.storeKey,
            jobId: job.id,
          }),
        })),
      });
      const claims = new Map(preparation.claims.map((claim) => [claim.handle.jobId, claim]));
      const prior = new Map(preparation.prior.map((receipt) => [receipt.jobId, receipt]));
      const outcome: CronRuntimeMutationContracts["cron.reserveRuns"]["outcome"] = {
        reservations: [],
        conflicts: [],
      };
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      for (const candidate of input.candidates) {
        if (outcome.reservations.length >= input.maxReservations) {
          break;
        }
        const job = jobsById.get(candidate.id);
        if (!job) {
          continue;
        }
        const prepared = claims.get(job.id);
        if (!candidate || !prepared) {
          continue;
        }
        try {
          assertCronAgentMigrationAdmitted(db, input.storeKey, prepared.handle.agentId);
        } catch (error) {
          if (error instanceof CronAgentMigrationHeldError) {
            continue;
          }
          throw error;
        }
        if (!prior.has(job.id)) {
          try {
            adjudicateActiveCronRunReceiptInDatabase({
              database: db,
              jobId: job.id,
              prepared,
              finishedAtMs: input.reservedAtMs,
            });
          } catch (error) {
            if (!(error instanceof CronRunReceiptConflictError)) {
              throw error;
            }
            outcome.conflicts.push(error.candidate);
            continue;
          }
        }
        if (
          job.enabled !== candidate.enabled ||
          (!input.immediateJobIds.includes(job.id) &&
            job.state.nextRunAtMs !== candidate.state.nextRunAtMs) ||
          job.state.lastRunAtMs !== candidate.state.lastRunAtMs ||
          job.state.lastRunStatus !== candidate.state.lastRunStatus ||
          job.state.queuedAtMs !== undefined ||
          job.state.runningAtMs !== undefined ||
          resolveCronJobConfigRevision(job) !== resolveCronJobConfigRevision(candidate)
        ) {
          continue;
        }
        const previous = prior.get(job.id);
        if (previous) {
          finishCronRunReceiptInDatabase({
            database: db,
            handle: previous,
            status: "superseded",
            finishedAtMs: input.reservedAtMs,
            error: "cron reservation replaced before activation",
          });
        }
        const runReceipt = claimCronRunReceiptInDatabase({
          retainLocalOwnership: false,
          database: db,
          prepared,
          resolveAgentId: (current) =>
            resolveCronJobEffectiveAgentId(current, preparation.defaultAgentId),
        });
        if (input.onExit) {
          job.enabled = false;
          job.updatedAtMs = input.reservedAtMs;
          job.state.scheduleActivatedAtMs = input.reservedAtMs;
          delete job.state.nextRunAtMs;
          delete job.state.startupCatchupAtMs;
          delete job.state.pacedNextRunAtMs;
          delete job.state.forcePreservedNextRunAtMs;
        } else if (input.preserve) {
          retainManualOneShotOccurrence(job, input.ownershipAtMs);
        }
        job.state.queuedAtMs = input.reservedAtMs;
        const row = rows.find((candidateRow) => candidateRow.job_id === job.id)!;
        upsertCronJobRow(db, input.storeKey, job, row.sort_order, { knownExistingRow: row });
        outcome.reservations.push({ job, runReceipt });
      }
      return retainCronRuntimeMutationOutcome("cron.reserveRuns", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-reservation" },
  );
}
