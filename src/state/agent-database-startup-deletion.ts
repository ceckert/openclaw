import { retryAsync, type RetryOptions } from "../infra/retry.js";
import type { createPermitPool } from "../shared/permit-pool.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseDeletionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { readAgentDeletionJournalStatusInWorker } from "./agent-deletion-journal.read.js";

export async function assertStartupAgentNotDeleted(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  refusal: AgentDatabaseAdmissionRefusal;
  journalReads: ReturnType<typeof createPermitPool>;
  retry: RetryOptions;
  assertCurrent: () => void;
}): Promise<void> {
  const deletion = await retryAsync(async () => {
    const release = await params.journalReads.acquire({ signal: params.signal });
    try {
      params.assertCurrent();
      return await readAgentDeletionJournalStatusInWorker(
        params.agentId,
        { env: params.env },
        params.signal,
      );
    } finally {
      release?.();
    }
  }, params.retry);
  params.assertCurrent();
  if (deletion !== "absent") {
    throw new AgentDatabaseAdmissionError(createAgentDatabaseDeletionRefusal(params.refusal));
  }
}
