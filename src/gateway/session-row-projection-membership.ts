import type { AsyncLocalStorage } from "node:async_hooks";
import { listSessionMembersInWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { takeSessionRowBatch } from "./session-projection-work.js";
import * as records from "./session-row-projection-record.js";

export function invalidate(row: records.Row, dirty: Set<string>) {
  row.membership = new Set();
  dirty.add(records.identity(row));
}

export function acquire(row: records.Row, previous: records.Row | undefined, dirty: Set<string>) {
  if (
    !previous ||
    previous.generation !== row.generation ||
    previous.entry?.sessionId !== row.entry?.sessionId
  ) {
    invalidate(row, dirty);
  }
}

export function invalidateChange(
  change: Extract<SessionRowChange, { all: true }>,
  rows: Iterable<records.Row>,
  matching: (query: records.Query) => records.Row[],
  dirty: Set<string>,
) {
  if (
    change.scope === "stores" ||
    change.scope === "profiles" ||
    typeof change.scope !== "string"
  ) {
    for (const row of typeof change.scope === "string" ? rows : matching(change.scope)) {
      invalidate(row, dirty);
    }
  }
}

export function unprepared(
  queries: readonly records.Lookup[],
  lookup: (query: records.Lookup) => records.Row | undefined,
  dirty: Set<string>,
) {
  return queries.flatMap((query) => {
    if (isIncognitoSessionKey(query.key)) {
      return [];
    }
    const row = lookup(query);
    return row && dirty.has(records.identity(row)) ? [row] : [];
  });
}

export async function prepare(
  owner: {
    rows: ReadonlyMap<string, records.Row>;
    dirty: Set<string>;
    revision: () => number | undefined;
    storeIdentity: (path: string) => string | symbol | undefined;
    inOwnerContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
    published: () => void;
  },
  requested: readonly records.Row[] = takeSessionRowBatch(owner.dirty).flatMap(
    (id) => owner.rows.get(id) ?? [],
  ),
) {
  const revision = owner.revision();
  if (revision === undefined) {
    return;
  }
  const targets = takeSessionRowBatch(
    new Map(
      requested
        .filter((row) => owner.dirty.has(records.identity(row)))
        .map((row) => [records.identity(row), row]),
    ).values(),
  ).map((row) => ({
    row,
    sessionId: row.entry?.sessionId,
    generation: row.generation,
    storeIdentity: owner.storeIdentity(row.storeTarget.storePath),
  }));
  if (targets.length === 0) {
    return;
  }
  const members = await Promise.all(
    targets.map(({ row }) =>
      owner.inOwnerContext(() =>
        listSessionMembersInWorker({ ...row.storeTarget, sessionKey: row.key }),
      ),
    ),
  );
  if (owner.revision() !== revision) {
    return;
  }
  for (const [index, target] of targets.entries()) {
    const id = records.identity(target.row);
    const current = owner.rows.get(id);
    if (
      !current ||
      current.generation !== target.generation ||
      current.entry?.sessionId !== target.sessionId ||
      owner.storeIdentity(current.storeTarget.storePath) !== target.storeIdentity
    ) {
      continue;
    }
    current.membership = new Set(members[index]!.map((member) => member.identityId));
    owner.dirty.delete(id);
    owner.published();
  }
}
