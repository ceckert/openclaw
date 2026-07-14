import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { z } from "zod";
import {
  getMattermostActivityGatewayRuntime,
  type MattermostActivityGatewayRuntime,
} from "./activity-gateway-runtime.js";

const statusParamsSchema = z.object({ inputPostId: z.string().trim().min(1) }).strict();
const cancelParamsSchema = z
  .object({
    inputPostId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();
const retryParamsSchema = z
  .object({
    failedRunId: z.string().trim().min(1),
    markerPostId: z.string().trim().min(1),
    actorMmUserId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();
const snapshotParamsSchema = z.union([
  z.object({}).strict(),
  z.object({ runId: z.string().trim().min(1) }).strict(),
]);

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayHandlerOptions = Parameters<GatewayHandler>[0];

function assertBackendClient(options: GatewayHandlerOptions): boolean {
  if (options.client?.connect.client.mode === "backend") {
    return true;
  }
  options.respond(false, undefined, {
    code: "FORBIDDEN",
    message: "Mattermost activity methods require an authenticated backend client",
  });
  return false;
}

function respondInvalid(options: GatewayHandlerOptions, error: z.ZodError): void {
  options.respond(false, undefined, {
    code: "INVALID_REQUEST",
    message: "Invalid Mattermost activity method parameters",
    details: error.flatten(),
  });
}

function respondInternal(options: GatewayHandlerOptions, error: unknown): void {
  options.respond(false, undefined, {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}

export function registerMattermostAgentGatewayMethods(
  api: OpenClawPluginApi,
  options?: { runtime?: () => MattermostActivityGatewayRuntime },
): void {
  const runtime = options?.runtime ?? getMattermostActivityGatewayRuntime;

  api.registerGatewayMethod(
    "mattermost.ingress.status",
    async (request) => {
      if (!assertBackendClient(request)) {
        return;
      }
      const parsed = statusParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        respondInvalid(request, parsed.error);
        return;
      }
      try {
        request.respond(true, await runtime().status(parsed.data.inputPostId));
      } catch (error) {
        respondInternal(request, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "mattermost.ingress.cancel",
    async (request) => {
      if (!assertBackendClient(request)) {
        return;
      }
      const parsed = cancelParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        respondInvalid(request, parsed.error);
        return;
      }
      try {
        request.respond(
          true,
          await runtime().cancel(parsed.data.inputPostId, parsed.data.idempotencyKey),
        );
      } catch (error) {
        respondInternal(request, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "mattermost.ingress.retry",
    async (request) => {
      if (!assertBackendClient(request)) {
        return;
      }
      const parsed = retryParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        respondInvalid(request, parsed.error);
        return;
      }
      try {
        request.respond(true, await runtime().retry(parsed.data));
      } catch (error) {
        respondInternal(request, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "agent.activity.snapshot",
    async (request) => {
      if (!assertBackendClient(request)) {
        return;
      }
      const parsed = snapshotParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        respondInvalid(request, parsed.error);
        return;
      }
      try {
        request.respond(
          true,
          "runId" in parsed.data
            ? await runtime().resolveRun(parsed.data.runId)
            : await runtime().snapshot(),
        );
      } catch (error) {
        respondInternal(request, error);
      }
    },
    { scope: "operator.read" },
  );
}

export function registerMattermostAgentGatewayMethodsFromApi(api: OpenClawPluginApi): void {
  registerMattermostAgentGatewayMethods(api);
}
