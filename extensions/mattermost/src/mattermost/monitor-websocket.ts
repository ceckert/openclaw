import { randomUUID } from "node:crypto";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { z } from "openclaw/plugin-sdk/zod";
import WebSocket from "ws";
import { MattermostPostSchema, type MattermostPost } from "./client.js";
import { rawDataToString } from "./monitor-helpers.js";
import type { ChannelAccountSnapshot, RuntimeEnv } from "./runtime-api.js";

export type MattermostEventPayload = {
  event?: string;
  data?: {
    post?: string | MattermostPost;
    reaction?: string | Record<string, unknown>;
    channel_id?: string;
    channel_name?: string;
    channel_display_name?: string;
    channel_type?: string;
    sender_name?: string;
    team_id?: string;
  };
  broadcast?: {
    channel_id?: string;
    team_id?: string;
    user_id?: string;
  };
};

export type MattermostWebSocketLike = {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: WebSocket.RawData) => void | Promise<void>): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  send(data: string): void;
  /**
   * Send a WebSocket-protocol ping frame. Mattermost's server replies with
   * a pong which resets the server-side read deadline — without this, MM
   * closes the socket with `i/o timeout` after ~30s of no inbound bytes.
   * Standard-library `ws.WebSocket.ping()` signature; `data` and `cb` are
   * optional per the spec.
   */
  ping(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;
  close(): void;
  terminate(): void;
};

export type MattermostWebSocketFactory = (url: string) => MattermostWebSocketLike;
const MattermostEventPayloadSchema = z.object({
  event: z.string().optional(),
  data: z
    .object({
      post: z.union([z.string(), MattermostPostSchema]).optional(),
      reaction: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      channel_id: z.string().optional(),
      channel_name: z.string().optional(),
      channel_display_name: z.string().optional(),
      channel_type: z.string().optional(),
      sender_name: z.string().optional(),
      team_id: z.string().optional(),
    })
    .optional(),
  broadcast: z
    .object({
      channel_id: z.string().optional(),
      team_id: z.string().optional(),
      user_id: z.string().optional(),
    })
    .optional(),
}) as z.ZodType<MattermostEventPayload>;

function parseMattermostEventPayload(raw: string): MattermostEventPayload | null {
  return safeParseJsonWithSchema(MattermostEventPayloadSchema, raw);
}

function parseMattermostPost(value: unknown): MattermostPost | null {
  if (typeof value === "string") {
    return safeParseJsonWithSchema(MattermostPostSchema, value);
  }
  return safeParseWithSchema(MattermostPostSchema, value);
}

export class WebSocketClosedBeforeOpenError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason?: string,
  ) {
    super(`websocket closed before open (code ${code})`);
    this.name = "WebSocketClosedBeforeOpenError";
  }
}

type CreateMattermostConnectOnceOpts = {
  wsUrl: string;
  botToken: string;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  runtime: RuntimeEnv;
  nextSeq: () => number;
  onPosted: (post: MattermostPost, payload: MattermostEventPayload) => Promise<void>;
  onReaction?: (payload: MattermostEventPayload) => Promise<void>;
  webSocketFactory?: MattermostWebSocketFactory;
  /**
   * Called periodically to check whether the bot account has been modified
   * (e.g. disabled then re-enabled) since the WebSocket was opened.
   * Returns the bot's current `update_at` timestamp.  When it differs from
   * the value recorded at connect time, the connection is terminated so the
   * reconnect loop can establish a fresh one.
   */
  getBotUpdateAt?: () => Promise<number>;
  healthCheckIntervalMs?: number;
  /**
   * How often to send a WebSocket ping frame to keep the connection alive.
   * Mattermost's server has a ~30s read deadline on WS connections; without
   * periodic pings the socket is closed with `i/o timeout` and every
   * account's WS dies simultaneously (synchronized because they all share
   * the same "last inbound activity" moment when no channel is busy).
   * Default 15_000 (half of MM's 30s deadline for safety margin).
   */
  pingIntervalMs?: number;
};

export const defaultMattermostWebSocketFactory: MattermostWebSocketFactory = (url) => {
  const agent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
  return new WebSocket(url, agent ? { agent } : undefined) as MattermostWebSocketLike;
};

export function parsePostedPayload(
  payload: MattermostEventPayload,
): { payload: MattermostEventPayload; post: MattermostPost } | null {
  if (payload.event !== "posted") {
    return null;
  }
  const postData = payload.data?.post;
  if (!postData) {
    return null;
  }
  const post = parseMattermostPost(postData);
  if (!post) {
    return null;
  }
  return { payload, post };
}

export function parsePostedEvent(
  data: WebSocket.RawData,
): { payload: MattermostEventPayload; post: MattermostPost } | null {
  const raw = rawDataToString(data);
  const payload = parseMattermostEventPayload(raw);
  if (!payload) {
    return null;
  }
  return parsePostedPayload(payload);
}

export function createMattermostConnectOnce(
  opts: CreateMattermostConnectOnceOpts,
): () => Promise<void> {
  const webSocketFactory = opts.webSocketFactory ?? defaultMattermostWebSocketFactory;
  const healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 15_000;
  return async () => {
    const flowId = randomUUID();
    const ws = webSocketFactory(opts.wsUrl);
    const onAbort = () => ws.terminate();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const getBotUpdateAt = opts.getBotUpdateAt;

    try {
      return await new Promise<void>((resolve, reject) => {
        let opened = false;
        let settled = false;
        let healthCheckEnabled = getBotUpdateAt != null;
        let healthCheckInFlight = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
        let initialUpdateAt: number | undefined;
        // WS-protocol keepalive ping. setInterval rather than a chained
        // setTimeout: we want a fixed cadence regardless of event-loop
        // pressure, and each tick is cheap (queues an outbound frame).
        // Cleared in stopHealthChecks which runs from every exit path
        // (close, error, settle) so we can't leak the interval across
        // reconnects.
        let pingIntervalHandle: ReturnType<typeof setInterval> | undefined;

        const clearTimers = () => {
          if (healthCheckTimer !== undefined) {
            clearTimeout(healthCheckTimer);
            healthCheckTimer = undefined;
          }
          if (pingIntervalHandle !== undefined) {
            clearInterval(pingIntervalHandle);
            pingIntervalHandle = undefined;
          }
        };

        const stopHealthChecks = () => {
          healthCheckEnabled = false;
          clearTimers();
        };

        const scheduleHealthCheck = () => {
          if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
            return;
          }
          healthCheckTimer = setTimeout(() => {
            healthCheckTimer = undefined;
            void runHealthCheck();
          }, healthCheckIntervalMs);
        };

        const runHealthCheck = async () => {
          if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
            return;
          }
          healthCheckInFlight = true;
          try {
            const current = await getBotUpdateAt();
            if (!healthCheckEnabled || settled) {
              return;
            }
            if (initialUpdateAt === undefined) {
              initialUpdateAt = current;
              return;
            }
            if (current !== initialUpdateAt) {
              opts.runtime.log?.(
                `mattermost: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`,
              );
              stopHealthChecks();
              ws.terminate();
            }
          } catch (err) {
            if (!healthCheckEnabled || settled) {
              return;
            }
            const label =
              initialUpdateAt === undefined
                ? "mattermost: failed to get initial update_at"
                : "mattermost: health check error";
            opts.runtime.error?.(`${label}: ${String(err)}`);
          } finally {
            healthCheckInFlight = false;
            scheduleHealthCheck();
          }
        };

        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          stopHealthChecks();
          resolve();
        };
        const rejectOnce = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          stopHealthChecks();
          reject(error);
        };

        ws.on("open", () => {
          opened = true;
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "ws-open",
            flowId,
            meta: { subsystem: "mattermost-websocket" },
          });
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          const authPayload = JSON.stringify({
            seq: opts.nextSeq(),
            action: "authentication_challenge",
            data: { token: opts.botToken },
          });
          captureWsEvent({
            url: opts.wsUrl,
            direction: "outbound",
            kind: "ws-frame",
            flowId,
            payload: authPayload,
            meta: { subsystem: "mattermost-websocket", eventType: "authentication_challenge" },
          });
          ws.send(authPayload);

          // Keepalive: send a WS ping every pingIntervalMs. Mattermost's
          // server read deadline is ~30s; without inbound bytes within
          // that window it closes the socket with `i/o timeout`. When
          // multiple accounts share a "last activity" moment (common at
          // boot — all accounts mount together), the read deadline fires
          // on every socket simultaneously, cascading into a
          // mass-disconnect storm as the gateway tries to reconnect them
          // all in parallel. A server-side pong resets the deadline, so
          // 15s-cadence pings keep each socket alive independently
          // regardless of channel idleness. Errors from ping are
          // swallowed — an unpingable socket is already dead and will
          // cascade through the normal close/error handlers.
          // One-shot fingerprint log so we can confirm we're running the
          // patched (keepalive-enabled) build. Appears once per WS-open
          // per account; ~7 lines on a 7-tenant gateway boot, then idle.
          // If this line is NOT in the gateway log, the custom image
          // didn't deploy and we're still on stock OpenClaw (no
          // keepalive, MM will close idle sockets).
          opts.runtime.log?.(
            `[octogee-patch] mattermost ws keepalive armed: pingIntervalMs=${pingIntervalMs}`,
          );
          pingIntervalHandle = setInterval(() => {
            try {
              ws.ping();
            } catch (err) {
              opts.runtime.error?.(`mattermost ws ping failed: ${String(err)}`);
            }
          }, pingIntervalMs);

          // Periodically check if the bot account was modified (e.g. disable/enable).
          // After such a cycle the WebSocket silently stops delivering events even
          // though the connection itself stays alive.  Comparing update_at detects
          // this reliably regardless of how quickly the cycle happens.
          if (getBotUpdateAt) {
            // Use a recursive timeout so only one REST poll can be in flight at a time.
            void runHealthCheck();
          }
        });

        ws.on("message", async (data) => {
          captureWsEvent({
            url: opts.wsUrl,
            direction: "inbound",
            kind: "ws-frame",
            flowId,
            payload: Buffer.from(rawDataToString(data)),
            meta: { subsystem: "mattermost-websocket" },
          });
          const raw = rawDataToString(data);
          const payload = parseMattermostEventPayload(raw);
          if (!payload) {
            return;
          }

          if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
            if (!opts.onReaction) {
              return;
            }
            try {
              await opts.onReaction(payload);
            } catch (err) {
              opts.runtime.error?.(`mattermost reaction handler failed: ${String(err)}`);
            }
            return;
          }

          if (payload.event !== "posted") {
            return;
          }
          const parsed = parsePostedPayload(payload);
          if (!parsed) {
            return;
          }
          try {
            await opts.onPosted(parsed.post, parsed.payload);
          } catch (err) {
            opts.runtime.error?.(`mattermost handler failed: ${String(err)}`);
          }
        });

        ws.on("close", (code, reason) => {
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "ws-close",
            flowId,
            closeCode: code,
            payload: reason,
            meta: { subsystem: "mattermost-websocket" },
          });
          stopHealthChecks();
          const message = reasonToString(reason);
          opts.statusSink?.({
            connected: false,
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: message || undefined,
            },
          });
          if (opened) {
            resolveOnce();
            return;
          }
          rejectOnce(new WebSocketClosedBeforeOpenError(code, message || undefined));
        });

        ws.on("error", (err) => {
          captureWsEvent({
            url: opts.wsUrl,
            direction: "local",
            kind: "error",
            flowId,
            errorText: String(err),
            meta: { subsystem: "mattermost-websocket" },
          });
          opts.runtime.error?.(`mattermost websocket error: ${String(err)}`);
          opts.statusSink?.({
            lastError: String(err),
          });
          try {
            ws.close();
          } catch {}
        });
      });
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function reasonToString(reason: Buffer | string | undefined): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.length > 0 ? reason.toString("utf8") : "";
}
