import { withNormalizedTimestamp } from "openclaw/plugin-sdk/channel-actions";
import type { MattermostPost } from "./client.js";

export type MattermostPostList = { order?: string[]; posts?: Record<string, MattermostPost> };

export function postListToMessages(list: MattermostPostList): MattermostPost[] {
  const posts = list.posts ?? {};
  return (list.order ?? Object.keys(posts)).flatMap((postId) => {
    const post = posts[postId];
    return post ? [post] : [];
  });
}

export function normalizeMattermostMessages(messages: MattermostPost[]): Record<string, unknown>[] {
  return messages.map((message) => withNormalizedTimestamp(message, message.create_at));
}
