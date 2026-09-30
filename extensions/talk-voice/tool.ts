import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";

export async function executeTalkVoiceTool(
  sessionKey: string | undefined,
  ...toolArgs: Parameters<AnyAgentTool["execute"]>
) {
  const [, args, signal] = toolArgs;
  const params = asOptionalRecord(args) ?? {};
  const action = readStringParam(params, "action", { required: true });
  let timeoutMs = 65_000;
  let method: string;
  let request: Record<string, string>;
  switch (action) {
    case "list":
      method = "talk.voice.get";
      request = {};
      break;
    case "speak": {
      method = "talk.voice.speak";
      const text = readStringParam(params, "text", { required: true });
      request = { text };
      if (text.length > 8_000) {
        throw new Error("Voice narration must be at most 8000 characters");
      }
      timeoutMs += text.length * 150;
      break;
    }
    case "set":
      method = "talk.voice.set";
      request = { voice: readStringParam(params, "voice", { required: true }) };
      break;
    default:
      throw new Error(`Unknown Talk voice action: ${action}`);
  }
  if (sessionKey) {
    request.sessionKey = sessionKey;
  }
  return jsonResult(
    await callGatewayTool(method, { timeoutMs }, request, {
      requireAgentRuntimeIdentity: true,
      signal,
    }),
  );
}
