import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

/** Report the exact host that closed so an older broker cannot clear its replacement. */
export function createGatewaySpawnBrokerHost(options: {
  onReady: (pid: number, restarted: boolean) => void;
  onClosed: (closed: SpawnBrokerHost) => void;
}): SpawnBrokerHost {
  const broker = createSpawnBrokerHost({
    onReady: options.onReady,
    onClosed: () => options.onClosed(broker),
  });
  return broker;
}
