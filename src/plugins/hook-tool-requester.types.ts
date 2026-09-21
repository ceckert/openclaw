/** Host-derived identity for the message requester that initiated a tool call. */
export type PluginHookToolRequesterContext = {
  /** Live Gateway-authenticated human identity; undefined after connection revocation. Never derived from sender labels. */
  readonly getAuthenticatedIdentity?: () =>
    | Readonly<{ profileId: string; userId?: string }>
    | undefined;
  /** Channel/plugin id, for example `discord` or `telegram`. */
  readonly channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  readonly accountId?: string;
  /** Channel-scoped sender id when the host received one. */
  readonly senderId?: string;
  /** True only when the host resolved the sender as an owner. */
  readonly senderIsOwner?: boolean;
  /** Provider-native role ids when the channel supplies them. */
  readonly roleIds?: readonly string[];
};
