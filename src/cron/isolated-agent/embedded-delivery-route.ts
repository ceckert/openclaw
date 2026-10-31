import { resolveCronScheduledRequester } from "../tools-allow-provenance.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";

/** The embedded run's delivery route, with the job creator bound to that same route. */
export function resolveCronEmbeddedDeliveryRoute(
  job: Parameters<typeof resolveCronScheduledRequester>[0],
  delivery: DeliveryTargetResolution,
) {
  return {
    messageTo: delivery.to,
    messageThreadId: delivery.threadId,
    scheduledRequester: resolveCronScheduledRequester(job, delivery),
  };
}
