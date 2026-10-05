import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import * as models from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as secrets from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabasePreparationSupersededError,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateGatewayAgentDatabaseStartup } from "./server-agent-database-startup.js";

afterEach(() => vi.restoreAllMocks());

it.for(["config", "secrets", "owner", "shutdown", "model-failure", "model-supersession"] as const)(
  "retains the startup publication guard when the model build ends after %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const agentId = "main";
      let config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      const snapshot = await secrets.prepareSecretsRuntimeSnapshot({
        config,
        env,
        agentDirs: [resolveAgentDir(config, agentId, env)],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });
      let revision = 0;
      let ownerCurrent = true;
      const lifetime = new AbortController();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const nativeFailure =
        outcome === "model-failure"
          ? new Error("genuine model build failure")
          : new PreparedModelRuntimePublicationSupersededError("native model publication retired");
      vi.spyOn(secrets, "getActiveSecretsRuntimeSnapshot").mockReturnValue(snapshot);
      vi.spyOn(secrets, "getActiveSecretsRuntimeSnapshotRevision").mockImplementation(
        () => revision,
      );
      vi.spyOn(secrets, "refreshActiveSecretsRuntimeSnapshotForConfig").mockImplementation(
        async () => {
          revision += 1;
          return true;
        },
      );
      const refresh = vi
        .spyOn(models, "refreshPreparedModelRuntimeSnapshots")
        .mockImplementation(async (_config, options) => {
          entered.resolve();
          await release.promise;
          expect(options?.isPublicationCurrent?.()).toBe(
            outcome === "model-failure" || outcome === "model-supersession",
          );
          throw nativeFailure;
        });
      await withAgentDatabaseStartupAdmission(async (admission) => {
        let activation: Parameters<typeof admission.activate>[0] | undefined;
        vi.spyOn(admission, "activate").mockImplementation((value) => {
          activation = value;
        });
        activateGatewayAgentDatabaseStartup({
          admission,
          preparationReady: Promise.resolve(),
          getConfig: () => config,
          getPluginRegistry: () => createEmptyPluginRegistry(),
          getPluginMetadataSnapshot: () => undefined,
          isCurrent: () => true,
          log: { info: vi.fn(), warn: vi.fn() },
        });
        if (!activation) {
          throw new Error("startup activation was not captured");
        }
        const paths = [resolveOpenClawAgentSqlitePath({ agentId, env })];
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId,
          paths,
          pending: true,
          reason: "synthetic completed startup inspection",
        });
        recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
        const assertCurrent = () => {
          if (!ownerCurrent) {
            throw new Error("startup owner revoked");
          }
        };
        const publish = preparePendingAgentDatabase(refusal, { env, assertCurrent }, () =>
          activation!.publishAgent({
            agentId,
            paths,
            env,
            signal: lifetime.signal,
            assertCurrent,
            phase: vi.fn(),
          }),
        );
        void publish.catch(() => undefined);
        try {
          await Promise.race([entered.promise, publish]);
          if (outcome === "config") {
            config = { ...config };
          } else if (outcome === "secrets") {
            revision += 1;
          } else if (outcome === "owner") {
            ownerCurrent = false;
          } else if (outcome === "shutdown") {
            lifetime.abort(new Error("startup stopped"));
          }
          release.resolve();
          if (outcome === "config" || outcome === "secrets") {
            await expect(publish).rejects.toBeInstanceOf(AgentDatabasePreparationSupersededError);
          } else if (outcome === "owner") {
            await expect(publish).rejects.toThrow("startup owner revoked");
          } else if (outcome === "shutdown") {
            await expect(publish).rejects.toThrow("startup stopped");
          } else {
            await expect(publish).rejects.toBe(nativeFailure);
          }
          expect(refresh).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          await publish.catch(() => undefined);
        }
      });
    });
  },
);
