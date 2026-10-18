import { pluginInstanceInvocation } from "../../plugins/plugin-instance-invocation.js";
import {
  getPluginValueInstance,
  wrapCurrentPluginInstance,
} from "../../plugins/plugin-instance-scope.js";
import type { ChannelEventDeliveryAdapter, ChannelTurnDeliveryAdapter } from "./types.js";

export function bindChannelDeliveryOwner(
  adapter: ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter,
  observeOnly: boolean,
) {
  const owner = observeOnly ? undefined : getPluginValueInstance(adapter);
  const delivery: ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter = observeOnly
    ? { deliver: async () => ({ visibleReplySent: false }) }
    : owner && owner === pluginInstanceInvocation.getStore()?.instance
      ? adapter
      : wrapCurrentPluginInstance(adapter);
  return {
    delivery,
    rawDeliver: delivery.deliver?.bind(delivery),
    rawProviderDeliver:
      "deliverWithProviderMessageSending" in delivery
        ? delivery.deliverWithProviderMessageSending?.bind(delivery)
        : undefined,
    preparedDeliver: delivery.deliverPrepared?.bind(delivery),
    preparedProviderDeliver:
      "deliverPreparedWithProviderMessageSending" in delivery
        ? delivery.deliverPreparedWithProviderMessageSending?.bind(delivery)
        : undefined,
  };
}
