import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  loadedCronStoreFromRows,
  resolveCronJobGrantDefinitionRevision,
  upsertCronJobRow,
} from "./row-codec.js";

export function materializeCronRowAgentOwners(
  db: DatabaseSync,
  storeKey: string,
  legacyDefaultAgentId: string,
): void {
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  const state =
    getNodeSqliteKysely<
      Pick<
        DB,
        | "cron_jobs"
        | "operator_approval_standing_grants"
        | "operator_approval_standing_grant_generations"
      >
    >(db);
  const rows = executeSqliteQuerySync(
    db,
    state.selectFrom("cron_jobs").selectAll().where("store_key", "=", storeKey),
  ).rows;
  for (const row of rows) {
    const job = loadedCronStoreFromRows([row]).store.jobs[0];
    if (!job || row.agent_id || tryResolveCronJobEffectiveAgentId(job)) {
      continue;
    }
    const grants =
      tableExists(db, "operator_approval_standing_grants") &&
      tableExists(db, "operator_approval_standing_grant_generations") &&
      typeof row.grant_definition_generation === "number" &&
      row.grant_definition_revision === resolveCronJobGrantDefinitionRevision(job) &&
      row.grant_definition_updated_at === row.updated_at
        ? executeSqliteQuerySync(
            db,
            state
              .selectFrom("operator_approval_standing_grants as g")
              .innerJoin(
                "operator_approval_standing_grant_generations as b",
                "b.grant_id",
                "g.grant_id",
              )
              .select("g.grant_id")
              .where("g.agent_id", "=", agentId)
              .where("g.cron_job_id", "=", job.id)
              .where("g.job_config_revision", "=", resolveCronJobConfigRevision(job))
              .where("g.revoked_at_ms", "is", null)
              .where("b.job_definition_generation", "=", row.grant_definition_generation),
          ).rows
        : [];
    const owned = upsertCronJobRow(db, storeKey, { ...job, agentId }, row.sort_order, {
      preserveRuntimeState: true,
    });
    if (grants.length === 0) {
      continue;
    }
    const generation = executeSqliteQuerySync(
      db,
      state
        .selectFrom("cron_jobs")
        .select("grant_definition_generation")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", job.id),
    ).rows[0]!.grant_definition_generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(
        `Cron owner materialization did not publish a grant generation for ${job.id}`,
      );
    }
    const ids = grants.map((grant) => grant.grant_id);
    executeSqliteQuerySync(
      db,
      state
        .updateTable("operator_approval_standing_grants")
        .set({ job_config_revision: resolveCronJobConfigRevision(owned) })
        .where("grant_id", "in", ids),
    );
    executeSqliteQuerySync(
      db,
      state
        .updateTable("operator_approval_standing_grant_generations")
        .set({ job_definition_generation: generation })
        .where("grant_id", "in", ids),
    );
  }
}
