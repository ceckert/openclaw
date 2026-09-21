import { expect, test } from "vitest";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("named preferences stay profile-scoped over authenticated multi-agent Gateway RPC", async () => {
  const origin = "https://preferences.example.test";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile(
    {
      agents: { ownership: "explicit", entries: { research: {}, review: {} } },
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: [origin] },
        roles: {
          default: "reader",
          definitions: {
            reader: {
              agents: "*",
              scopes: ["operator.read", "operator.write"],
              sessions: { others: "none" },
            },
          },
        },
      },
    },
    { allowedAgentRosterRemovals: ["main"] },
  );
  await withGatewayServer(async ({ port }) => {
    const socket = await openWs(port, {
      origin,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "preferences-reader@example.test",
    });
    try {
      const connected = await connectReq(socket, {
        skipDefaultAuth: true,
        client: CONTROL_UI_CLIENT,
        prePairDevice: true,
        scopes: ["operator.read", "operator.write"],
        browserOrigin: origin,
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      expect(connected.payload).toMatchObject({
        auth: { method: "trusted-proxy", scopes: ["operator.read", "operator.write"] },
      });
      expect(getRuntimeConfig().agents?.ownership).toBe("explicit");
      expect(Object.keys(getRuntimeConfig().agents?.entries ?? {})).toEqual(["research", "review"]);
      expect(getRuntimeConfig().gateway?.roles).toMatchObject({
        default: "reader",
        definitions: { reader: { sessions: { others: "none" } } },
      });
      const request = async (method: string, params: Record<string, unknown>) => {
        const response = await rpcReq(socket, method, params);
        console.log(
          JSON.stringify({
            method,
            params,
            ok: response.ok,
            payload: response.payload,
            error: response.error,
          }),
        );
        return response;
      };
      const entries = {
        "ui.theme": "dark",
        "agent:research:dashboard:incognito-preference": "personal",
      };
      const reader = ensureProfileForEmail("preferences-reader@example.test");
      expect(reader.id).not.toBe("gateway-owner");
      expect(await request("users.self", {})).toMatchObject({
        ok: true,
        payload: { profile: { id: reader.id } },
      });
      expect(await request("users.prefs.set", { entries })).toMatchObject({ ok: true });
      expect(await request("users.prefs.get", {})).toMatchObject({
        ok: true,
        payload: { status: "ok", entries },
      });
      for (const [key, value] of Object.entries(entries)) {
        expect.soft(await request("users.prefs.get", { keys: [key] })).toMatchObject({
          ok: true,
          payload: { status: "ok", entries: { [key]: value } },
        });
      }
      const ownKey = "agent:research:own";
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: ownKey },
        {
          sessionId: "own-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: reader.id },
        },
      );
      expect(await request("sessions.preview", { keys: [ownKey] })).toMatchObject({ ok: true });
      const other = ensureProfileForEmail("foreign-owner@example.test");
      const key = "agent:research:foreign";
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: key },
        {
          sessionId: "foreign-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: other.id },
        },
      );
      expect(await request("sessions.preview", { keys: [key] })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    } finally {
      socket.close();
    }
  });
});
