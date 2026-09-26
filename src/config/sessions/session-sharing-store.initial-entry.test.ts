import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry } from "./session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { ensureSessionEntryInWorker } from "./session-sharing-store.async.js";

it("creates and publishes channel identities off the caller thread before returning", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", sessionKey: "agent:main:mattermost:group:initial" };
    const entry = { sessionId: "channel-initial", updatedAt: 1, createdVia: "channel" as const };
    const database = openOpenClawAgentDatabase(scope);
    readSessionEntryCache(database, { cache: true });
    expect(readCommittedSessionEntryCache(database.db)).toBeDefined();
    const changes: SessionRowChange[] = [];
    const identities: SessionIdentityMutation[] = [];
    const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
    const stopIdentity = onSessionIdentityMutation((identity) => identities.push(identity));
    const sql = observeHostDataSql(state.env);
    try {
      expect(await ensureSessionEntryInWorker(scope, entry, () => {})).toBe(true);
      expect(sql.queries).toEqual([]);
      expect(readCommittedSessionEntryCache(database.db)).toBeUndefined();
      expect(changes).toContainEqual(
        expect.objectContaining({
          sessionKey: scope.sessionKey,
          facts: expect.objectContaining({ kind: "entry", sessionId: entry.sessionId }),
        }),
      );
      expect(identities).toEqual([
        {
          agentId: scope.agentId,
          databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
          kind: "create",
          previous: { sessionKeys: [] },
          current: { sessionId: entry.sessionId, sessionKeys: [scope.sessionKey] },
        },
      ]);
      const publicationCount = changes.length;
      expect(await ensureSessionEntryInWorker(scope, entry, () => {})).toBe(true);
      expect(changes).toHaveLength(publicationCount);
      expect(identities).toHaveLength(1);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      stop();
      stopIdentity();
    }
    expect(loadSessionEntry(scope)).toMatchObject(entry);
  });
});

it.each(["concurrent-row", "revoked"] as const)(
  "rechecks queued creation against %s before writing",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:mattermost:group:queued-initial" };
      const initial = { sessionId: "initial", updatedAt: 1, createdVia: "channel" as const };
      const existing = { sessionId: "concurrent", updatedAt: 2, createdVia: "operator" as const };
      openOpenClawAgentDatabase(scope);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let current = true;
      const holding = runOpenClawAgentWriteAdmission(scope, async () => {
        entered.resolve();
        await release.promise;
        if (change === "concurrent-row") {
          ensureSessionEntrySync(scope, existing);
        }
      });
      await entered.promise;
      const pending = ensureSessionEntryInWorker(scope, initial, () => {
        if (!current) {
          throw new Error("channel authority revoked");
        }
      });
      const checked =
        change === "revoked"
          ? expect(pending).rejects.toThrow("channel authority revoked")
          : expect(pending).resolves.toBe(false);
      if (change === "revoked") {
        current = false;
      }
      release.resolve();
      await holding;
      await checked;
      if (change === "concurrent-row") {
        expect(loadSessionEntry(scope)).toMatchObject(existing);
      } else {
        expect(loadSessionEntry(scope)).toBeUndefined();
      }
    });
  },
);
