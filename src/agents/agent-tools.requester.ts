import { getCommandSenderAuthority } from "../auto-reply/command-sender-authority.js";
import type { PluginHookToolRequesterContext } from "../plugins/hook-types.js";

type ToolRequesterSource = {
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string;
  senderId?: string | null;
  senderIsOwner?: boolean;
  memberRoleIds?: readonly string[];
};

export function buildToolRequesterContext(
  source: ToolRequesterSource | undefined,
): PluginHookToolRequesterContext {
  const channel = source?.messageChannel ?? source?.messageProvider;
  const getAuthenticatedIdentity = getCommandSenderAuthority(source);
  return {
    ...(getAuthenticatedIdentity ? { getAuthenticatedIdentity } : {}),
    ...(channel ? { channel } : {}),
    ...(source?.agentAccountId ? { accountId: source.agentAccountId } : {}),
    ...(source?.senderId ? { senderId: source.senderId } : {}),
    ...(source?.senderIsOwner !== undefined ? { senderIsOwner: source.senderIsOwner } : {}),
    ...(source?.memberRoleIds?.length ? { roleIds: [...source.memberRoleIds] } : {}),
  };
}
