import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";

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
