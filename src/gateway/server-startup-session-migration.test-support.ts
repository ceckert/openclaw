import path from "node:path";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
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

/** Exercise admission and its repair handoff together for existing store fixtures. */
export async function runStartupSessionMaintenanceForTest(
  params: Parameters<typeof prepareGatewayStartupSessions>[0],
): Promise<void> {
  const databases = await prepareGatewayStartupSessions(params);
  await runGatewaySessionStartupMaintenance({ ...params, databases });
}
