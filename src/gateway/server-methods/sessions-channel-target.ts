import { ok } from "@openclaw/normalization-core/result";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { prepareSessionStoreTargetInventory } from "../../config/sessions/session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  prepareGatewaySessionStoreTargetReadOnly,
  type GatewaySessionStoreDiscoveryCache,
} from "../session-utils-store-lookup.js";

export async function prepareChannelSessionTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId: string;
}) {
  const inventory = prepareSessionStoreTargetInventory(params.cfg, [params.agentId]);
  const registry = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env: inventory.env });
  return await withSessionHistoryWorkerReadCandidates(inventory.candidates, async (discovery) => {
    let sources = await discovery.readTargetInventory({
      ...inventory,
      registeredDatabases: { status: "deferred" },
    });
    let assertRegistry: (() => void) | undefined;
    if (sources.kind === "session-target-registry-required") {
      const current = await registry.read();
      assertRegistry = current.assertCurrent;
      assertRegistry();
      sources = await discovery.readTargetInventory({
        ...inventory,
        registeredDatabases:
          current.result.status === "available"
            ? current.result.entries
            : { status: "unavailable" },
      });
    }
    if (sources.kind !== "session-target-inventory") {
      throw new Error("Channel session target inventory is unavailable");
    }
    const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
    for (const source of sources.agents) {
      if (!source.result.available && source.result.reason !== "database-missing") {
        throw new Error(`Channel session target is unavailable: ${source.result.reason}`);
      }
      targetDiscoveryCache.set(source.agentId, {
        existing: source.result.available ? source.result.targets : [],
        fallback: {
          agentId: source.agentId,
          storePath: inventory.paths.get(source.agentId)!.configured,
        },
      });
    }
    const target = await prepareGatewaySessionStoreTargetReadOnly(
      {
        ...params,
        cfg: inventory.config,
        env: inventory.env,
        targetDiscoveryCache,
      },
      async (reads) => {
        await withSessionEntriesFromStoresInWorker(
          reads.map((read) => ({
            agentId: read.agentId ?? params.agentId,
            storePath: read.storePath,
            sessionKeys: read.options.exactKeys!,
            projection: "sharing",
            env: inventory.env,
          })),
          (prepared) => {
            for (const [index, read] of reads.entries()) {
              const current = prepared[index]!;
              current.assertCurrent();
              read.result = ok(
                Object.fromEntries(
                  current.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                ),
              );
              read.readSource = current.result.sharing?.source;
            }
          },
        );
      },
    );
    discovery.assertCurrent();
    assertRegistry?.();
    return target;
  });
}
