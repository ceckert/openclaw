import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cronJobReadView } from "../../cron/job-read-view.js";
import {
  normalizeCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../../cron/scheduled-tool-policy.js";
import { normalizeCronToolsAllowProvenance } from "../../cron/tools-allow-provenance.js";
import type { CronJob, CronJobCreate, CronStoredJob } from "../../cron/types.js";
import type { GatewayClient } from "./types.js";

const CRON_ADD_RESTORE_FIELDS = ["scheduledToolPolicy", "toolsAllowProvenance"] as const;

type CronAddRestoreFields = Partial<Record<(typeof CRON_ADD_RESTORE_FIELDS)[number], unknown>>;

/** Operators restore recorded authority; agent runtimes derive theirs from their signed identity. */
export function cronCallerIsOperator(client: GatewayClient | null | undefined): boolean {
  return !client?.internal?.agentRuntimeIdentity;
}

/**
 * Separates restore authority from the job definition. Create normalization drops malformed
 * authority silently, so these fields are validated from the caller's own values instead.
 */
export function takeCronAddRestoreFields(params: unknown): {
  params: unknown;
  fields: CronAddRestoreFields;
} {
  if (!isRecord(params)) {
    return { params, fields: {} };
  }
  const definition: Record<string, unknown> = { ...params };
  const fields: CronAddRestoreFields = {};
  for (const field of CRON_ADD_RESTORE_FIELDS) {
    if (definition[field] !== undefined) {
      fields[field] = definition[field];
    }
    delete definition[field];
  }
  return { params: definition, fields };
}

/** Returns the authority to store in place of the caller-derived one, or throws an invalid-params reason. */
export function resolveCronAddRestoredAuthority(
  fields: CronAddRestoreFields,
  client: GatewayClient | null,
  owner: CronJobCreate["owner"],
) {
  if (fields.scheduledToolPolicy === undefined && fields.toolsAllowProvenance === undefined) {
    return undefined;
  }
  if (!cronCallerIsOperator(client)) {
    throw new TypeError("scheduledToolPolicy and toolsAllowProvenance are operator-only fields");
  }
  let scheduledToolPolicy: CronScheduledToolPolicy | undefined;
  if (fields.scheduledToolPolicy !== undefined) {
    scheduledToolPolicy = normalizeCronScheduledToolPolicy(fields.scheduledToolPolicy);
    if (
      !scheduledToolPolicy ||
      (scheduledToolPolicy.mode === "account" &&
        (owner?.sessionKey !== scheduledToolPolicy.ownerSessionKey ||
          owner?.accountId !== scheduledToolPolicy.ownerAccountId))
    ) {
      throw new TypeError("scheduledToolPolicy must be a current policy matching the job owner");
    }
  }
  const toolsAllowProvenance =
    fields.toolsAllowProvenance === undefined
      ? undefined
      : normalizeCronToolsAllowProvenance(fields.toolsAllowProvenance);
  if (
    fields.toolsAllowProvenance !== undefined &&
    (!toolsAllowProvenance ||
      (isRecord(fields.toolsAllowProvenance) &&
        fields.toolsAllowProvenance.channelRequester !== undefined &&
        !toolsAllowProvenance.channelRequester))
  ) {
    throw new TypeError("toolsAllowProvenance must name a usable caller origin or requester");
  }
  return {
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    ...(toolsAllowProvenance ? { toolsAllowProvenance } : {}),
  };
}

/** Operators read a job's recorded creator provenance so a restore can reproduce it. */
export function cronOperatorJobReadView(
  job: CronJob & Pick<CronStoredJob, "toolsAllowProvenance">,
) {
  const toolsAllowProvenance = normalizeCronToolsAllowProvenance(job.toolsAllowProvenance);
  return {
    ...cronJobReadView(job),
    ...(toolsAllowProvenance ? { toolsAllowProvenance } : {}),
  };
}

export function cronJobReadViewForCaller(
  job: CronJob & Pick<CronStoredJob, "toolsAllowProvenance">,
  client: GatewayClient | null | undefined,
) {
  return cronCallerIsOperator(client) ? cronOperatorJobReadView(job) : cronJobReadView(job);
}
