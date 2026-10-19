import type { EngineConnection } from "../../infra/sql-connection.js";
import { sessionEntryCaches } from "./session-accessor.sqlite-entry-cache-state.js";

/** Inspect owner-held facts without populating or refreshing the cache. */
export function readCommittedSessionEntryCache(database: EngineConnection) {
  return sessionEntryCaches.get(database)?.entries;
}
