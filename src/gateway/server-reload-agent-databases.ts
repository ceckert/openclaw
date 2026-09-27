import { listAgentIds } from "../agents/agent-roster.js";
import { resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasDeletedAgentDatabases } from "../infra/agent-database-readers.js";
import { formatErrorMessage } from "../infra/errors.js";

/** A roster that admits an agent again may adopt databases its deletion left behind. */
export async function reviveConfiguredAgentDatabases(
  cfg: OpenClawConfig,
  warn: (message: string) => void,
): Promise<void> {
  if (!hasDeletedAgentDatabases()) {
    return;
  }
  const { reviveAgentDatabases } = await import("../state/openclaw-agent-db-readers.js");
  try {
    await reviveAgentDatabases(
      listAgentIds(cfg).map((agentId) =>
        resolveEffectiveAgentDir(cfg, agentId, { env: process.env }),
      ),
    );
  } catch (error) {
    warn(
      `config hot reload committed; deleted agent databases stay closed: ${formatErrorMessage(error)}`,
    );
  }
}
