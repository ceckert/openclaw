import path from "node:path";
import {
  applyAgentDatabaseReaderRequest,
  encodeAgentDatabaseReaderRequest,
  type AgentDatabaseReaderRequest,
} from "../infra/agent-database-readers.js";
import { closeWorkerTaskPoolResources } from "../infra/worker-task-pool-registry.js";

async function applyAcrossProcess(request: AgentDatabaseReaderRequest): Promise<void> {
  if (request.kind === "revive") {
    await closeWorkerTaskPoolResources(encodeAgentDatabaseReaderRequest(request));
    await applyAgentDatabaseReaderRequest(request);
    return;
  }
  await applyAgentDatabaseReaderRequest(request);
  await closeWorkerTaskPoolResources(encodeAgentDatabaseReaderRequest(request));
}

function resolveUnique(pathnames: readonly string[]): string[] {
  return [...new Set(pathnames.map((pathname) => path.resolve(pathname)))];
}

async function closeAcrossProcess(databasePaths: readonly string[], deleted: boolean) {
  const candidates = resolveUnique(databasePaths).map((pathname) => ({ path: pathname }));
  if (candidates.length > 0) {
    await applyAcrossProcess({ kind: "close", candidates, deleted });
  }
}

/** Close every retained reader of these databases in this isolate and every task-pool worker. */
export function closeAgentDatabaseReaders(databasePaths: readonly string[]): Promise<void> {
  return closeAcrossProcess(databasePaths, false);
}

/** Deletion closes the databases everywhere and refuses reopening them until the agent returns. */
export function closeDeletedAgentDatabases(databasePaths: readonly string[]): Promise<void> {
  return closeAcrossProcess(databasePaths, true);
}

/** A created agent may adopt databases a deletion left behind under its directories. */
export async function reviveAgentDatabases(agentDirs: readonly string[]): Promise<void> {
  const resolved = resolveUnique(agentDirs);
  if (resolved.length > 0) {
    await applyAcrossProcess({ kind: "revive", agentDirs: resolved });
  }
}
