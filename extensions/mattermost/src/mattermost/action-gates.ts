import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

// Discovery reads these tables on every tool description; keep this module free of
// client, send, and media imports so the execution path stays lazily loaded.
export type MattermostActionGate =
  | "messages"
  | "messageWrites"
  | "fileDownloads"
  | "reactions"
  | "pins"
  | "search"
  | "memberInfo";

/**
 * Gate, default, and the message-tool actions it exposes. `messages` keeps its
 * original read-only meaning so configs written before the write actions existed
 * do not gain edit, delete, upload, or download on upgrade.
 */
export const MATTERMOST_GATED_ACTIONS: ReadonlyArray<
  readonly [MattermostActionGate, boolean, readonly ChannelMessageActionName[]]
> = [
  ["reactions", true, ["react", "emoji-list"]],
  ["messages", false, ["read"]],
  ["messageWrites", false, ["edit", "delete", "upload-file"]],
  ["fileDownloads", false, ["download-file"]],
  ["pins", true, ["pin", "unpin", "list-pins"]],
  ["search", false, ["search"]],
  ["memberInfo", true, ["member-info", "channel-info"]],
];

/** Actions served by `runMattermostMessageAction`; `read` and `react` keep their own handlers. */
export const MATTERMOST_EXTENDED_ACTIONS: ReadonlySet<ChannelMessageActionName> = new Set(
  MATTERMOST_GATED_ACTIONS.flatMap((entry) => entry[2]).filter(
    (action) => action !== "read" && action !== "react",
  ),
);

export function resolveMattermostActionGate(
  action: ChannelMessageActionName,
): readonly [MattermostActionGate, boolean] | undefined {
  const entry = MATTERMOST_GATED_ACTIONS.find((candidate) => candidate[2].includes(action));
  return entry ? [entry[0], entry[1]] : undefined;
}
