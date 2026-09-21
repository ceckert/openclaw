import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import * as membershipSql from "../config/sessions/session-sharing-store.kernel.js";
import * as membershipWorker from "../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

const cfg = { agents: { entries: { main: {} } } };
const scope = { agentId: "main", sessionKey: "agent:main:member-projection" };
const query = { agentId: scope.agentId, key: scope.sessionKey };

it.each([false, true])(
  "prepares membership off-thread at hydration and refresh (archived: %s)",
  async (archived) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      replaceSessionEntrySync(scope, {
        sessionId: "members",
        updatedAt: 1,
        ...(archived ? { archivedAt: 1 } : {}),
      });
      addSessionMember(scope, { identityId: "member", addedBy: "owner" });
      const sql = vi.spyOn(membershipSql, "listSessionMembersInDatabase").mockImplementation(() => {
        throw new Error("membership SQL ran on the Gateway thread");
      });
      let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
      try {
        projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        await projection.ensureMaterialized();
        expect(projection.capture(query)?.membership.has("member")).toBe(true);
        removeSessionMember(scope, "member");
        await projection.withPreparedExactRows(
          () => [query],
          (read) => {
            expect(read.selectEntries({ key: query.key })[0]?.membership.has("member")).toBe(false);
          },
        );
        await projection.ensureMaterialized();
        expect(projection.capture(query)?.membership.has("member")).toBe(false);
        if (archived) {
          expect(projection.materializedCount).toBe(0);
        }
        expect(sql).not.toHaveBeenCalled();
      } finally {
        projection?.dispose();
      }
    });
  },
);

it.each(["revocation", "replacement"] as const)(
  "rejects a delayed membership result after %s without warming the archive",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      replaceSessionEntrySync(scope, { sessionId: "members", updatedAt: 1, archivedAt: 1 });
      addSessionMember(scope, { identityId: "member", addedBy: "owner" });
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      try {
        await projection.ensureMaterialized();
        const read = membershipWorker.listSessionMembersInWorker;
        const worker = vi
          .spyOn(membershipWorker, "listSessionMembersInWorker")
          .mockImplementationOnce(async (input) => {
            const members = await read(input);
            entered.resolve();
            await release.promise;
            return members;
          });
        sessionChanges.emit(scope);
        await entered.promise;
        if (change === "revocation") {
          removeSessionMember(scope, "member");
        } else {
          replaceSessionEntrySync(scope, { sessionId: "replacement", updatedAt: 2, archivedAt: 1 });
        }
        expect(projection.capture(query)?.membership.has("member")).toBe(false);
        release.resolve();
        await projection.ensureMaterialized();
        expect(worker.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(projection.capture(query)?.membership.has("member")).toBe(false);
        expect(projection.materializedCount).toBe(0);
      } finally {
        release.resolve();
        projection.dispose();
      }
    });
  },
);
