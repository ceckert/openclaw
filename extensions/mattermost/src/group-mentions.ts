// Mattermost plugin module implements group mentions behavior.
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { resolveMattermostAccount } from "./mattermost/accounts.js";
import type { ChannelGroupContext } from "./runtime-api.js";

export function isMattermostGroupEnabled(params: ChannelGroupContext): boolean {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const group = account.config.groups?.[params.groupId ?? ""] ?? account.config.groups?.["*"];
  return group?.enabled !== false;
}

export function resolveMattermostGroupRequireMention(
  params: ChannelGroupContext & { requireMentionOverride?: boolean },
): boolean | undefined {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const requireMentionOverride =
    typeof params.requireMentionOverride === "boolean"
      ? params.requireMentionOverride
      : account.requireMention;
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "mattermost",
    groupId: params.groupId,
    accountId: params.accountId,
    requireMentionOverride,
  });
}
