import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { resolveQuarantineStorePath } from "../state/openclaw-state-db.paths.js";
import {
  prepareGatewayStartupSessions,
  runGatewaySessionStartupMaintenance,
} from "./server-startup-session-migration.js";

export function saveStartupRecoveryAuthProfile(databasePath: string) {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "anthropic:startup-recovery": {
          type: "api_key",
          provider: "anthropic",
          keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_RECOVERY_SECRET" },
        },
      },
    },
    path.dirname(databasePath),
  );
}

export async function seedStartupRecoverySessions(env: NodeJS.ProcessEnv, agentIds: string[]) {
  const scopes = agentIds.map((agentId) => ({
    agentId,
    env,
    sessionId: "retained",
    sessionKey: `agent:${agentId}:retained`,
  }));
  for (const scope of scopes) {
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const message = { role: "user" as const, content: `history-${scope.agentId}` };
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: `retained-${scope.agentId}`, message }],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile(scope);
    saveStartupRecoveryAuthProfile(openOpenClawAgentDatabase(scope).path);
  }
  return scopes;
}

export function expireStartupRecoveryReceipts(env: NodeJS.ProcessEnv, agentIds: string[]) {
  const receipts = new DatabaseSync(resolveQuarantineStorePath(env));
  try {
    for (const agentId of agentIds) {
      receipts
        .prepare("UPDATE agent_integrity_verifications SET app_version = ? WHERE path = ?")
        .run("2026.9.7", resolveOpenClawAgentSqlitePath({ agentId, env }));
    }
  } finally {
    receipts.close();
  }
}

/** Exercise admission and its repair handoff together for existing store fixtures. */
export async function runStartupSessionMaintenanceForTest(
  params: Parameters<typeof prepareGatewayStartupSessions>[0],
): Promise<void> {
  const databases = await prepareGatewayStartupSessions(params);
  await runGatewaySessionStartupMaintenance({ ...params, databases });
}
