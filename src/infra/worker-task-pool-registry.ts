import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ResourceOwningPool = { closeResources(key?: string): Promise<void> };

const livePools = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskPools"),
  () => new Set<ResourceOwningPool>(),
);

export function registerLiveWorkerTaskPool(pool: ResourceOwningPool): () => void {
  livePools.add(pool);
  return () => {
    livePools.delete(pool);
  };
}

/** Ask every live pool's workers to close the retained resources this key names. */
export async function closeWorkerTaskPoolResources(key: string): Promise<void> {
  const results = await Promise.allSettled([...livePools].map((pool) => pool.closeResources(key)));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker resource cleanup failed");
  }
}
