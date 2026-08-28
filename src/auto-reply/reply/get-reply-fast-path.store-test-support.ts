import path from "node:path";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";

export function resolveIsolatedFastPathSessionStorePath(): string {
  const testHome = process.env.OPENCLAW_TEST_HOME;
  if (!testHome) {
    throw new Error("OPENCLAW_TEST_HOME must be set for fast reply tests");
  }
  return path.join(testHome, "fast-reply-sessions.json");
}

export async function seedFastPathSessionStore(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry as unknown as SessionEntry);
  }
}

export function readFastPathSessionEntry(
  storePath: string,
  sessionKey: string,
): Record<string, unknown> {
  return (
    (loadSessionEntry({ storePath, sessionKey }) as unknown as
      | Record<string, unknown>
      | undefined) ?? {}
  );
}
