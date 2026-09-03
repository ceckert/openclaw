import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  fetchMattermostChannelPosts,
  fetchMattermostPost,
  type MattermostClient,
  type MattermostPost,
} from "./client.js";
import type { HistoryEntry, OpenClawConfig } from "./runtime-api.js";

const RECOVERY_READ_LIMIT = 200;
const MAX_RECOVERY_ENTRIES = 20;
const MAX_ANSWER_PARTS = 20;
const MAX_REFERENCE_READS = 40;
const ANSWER_PART_KINDS = new Set(["text", "media", "voice", "poll", "card", "preview", "unknown"]);
const TERMINAL_OUTCOMES = new Set(["completed", "failed", "stopped"]);
const DELIVERY_OUTCOMES = new Set([
  "delivered",
  "partial",
  "failed",
  "suppressed",
  "not-attempted",
]);

type RecoveryAnswerPart = {
  postId: string;
  kind: string;
  index: number;
  rootPostId?: string;
  threadId?: string;
};

type RecoveryRunRef = {
  conversationId: string;
  turnId: string;
  runId: string;
  agentId: string;
  sessionKey: string;
  origin: string;
  mainChannelId: string;
  mainRootPostId: string;
  inputPostId: string;
  activityRootPostId: string;
};

type RecoveryAnswerCommit = {
  post: MattermostPost;
  ref: RecoveryRunRef;
  deliveryOutcome: string;
  parts: RecoveryAnswerPart[];
};

type RecoveryDependencies = {
  fetchChannelPosts: typeof fetchMattermostChannelPosts;
  fetchPost: typeof fetchMattermostPost;
  sessionExists: (params: { cfg: OpenClawConfig; agentId: string; sessionKey: string }) => boolean;
};

const defaultDependencies: RecoveryDependencies = {
  fetchChannelPosts: fetchMattermostChannelPosts,
  fetchPost: fetchMattermostPost,
  sessionExists: ({ cfg, agentId, sessionKey }) => {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    return Boolean(getSessionEntry({ storePath, sessionKey, readConsistency: "latest" }));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isZeroOrMissing(value: unknown): boolean {
  return value === undefined || value === null || value === 0;
}

function hasCanonicalRestPostShape(post: MattermostPost): boolean {
  const raw = record(post);
  if (!raw) {
    return false;
  }
  return (
    typeof raw.id === "string" &&
    typeof raw.user_id === "string" &&
    typeof raw.channel_id === "string" &&
    typeof raw.root_id === "string" &&
    typeof raw.message === "string" &&
    typeof raw.type === "string" &&
    finiteTimestamp(raw.create_at) !== undefined &&
    finiteTimestamp(raw.update_at) !== undefined &&
    finiteTimestamp(raw.edit_at) !== undefined &&
    finiteTimestamp(raw.delete_at) !== undefined &&
    typeof raw.pending_post_id === "string" &&
    (raw.file_ids === null ||
      (Array.isArray(raw.file_ids) && raw.file_ids.every((value) => typeof value === "string"))) &&
    (raw.props === null || record(raw.props) !== undefined)
  );
}

function isPostAvailable(post: MattermostPost): boolean {
  return hasCanonicalRestPostShape(post) && post.delete_at === 0;
}

function isOrdinaryPost(post: MattermostPost): boolean {
  return post.type === "" && isPostAvailable(post);
}

function postBody(post: MattermostPost): string | undefined {
  const message = normalized(post.message);
  const fileCount = new Set(
    Array.isArray(post.file_ids) ? post.file_ids.map(normalized).filter(Boolean) : [],
  ).size;
  const attachment =
    fileCount === 0
      ? undefined
      : fileCount === 1
        ? "[Mattermost attachment]"
        : `[${fileCount} Mattermost attachments]`;
  return (
    [message, attachment].filter((value): value is string => Boolean(value)).join("\n") || undefined
  );
}

function parseChannelSessionKey(
  sessionKey: string,
): { agentId: string; kind: "group" | "channel"; channelId: string } | undefined {
  const match = /^agent:([^:]+):mattermost:(group|channel):([^:]+)$/.exec(sessionKey);
  const kind = match?.[2];
  if (!match?.[1] || (kind !== "group" && kind !== "channel") || !match[3]) {
    return undefined;
  }
  return {
    agentId: match[1],
    kind,
    channelId: match[3],
  };
}

function parseRunRef(value: unknown): RecoveryRunRef | undefined {
  const raw = record(value);
  const conversationId = normalized(raw?.conversationId);
  const turnId = normalized(raw?.turnId);
  const runId = normalized(raw?.runId);
  const agentId = normalized(raw?.agentId);
  const sessionKey = normalized(raw?.sessionKey);
  const origin = normalized(raw?.origin);
  const mainChannelId = normalized(raw?.mainChannelId);
  const mainRootPostId = normalized(raw?.mainRootPostId);
  const inputPostId = normalized(raw?.inputPostId);
  const activityRootPostId = normalized(raw?.activityRootPostId);
  if (
    raw?.schemaVersion !== 3 ||
    raw.projectionKind !== "run" ||
    !conversationId ||
    !turnId ||
    !runId ||
    !agentId ||
    !sessionKey ||
    !origin ||
    !mainChannelId ||
    !mainRootPostId ||
    !inputPostId ||
    !activityRootPostId ||
    raw.conversationId !== conversationId ||
    raw.turnId !== turnId ||
    raw.runId !== runId ||
    raw.agentId !== agentId ||
    raw.sessionKey !== sessionKey ||
    raw.origin !== origin ||
    raw.mainChannelId !== mainChannelId ||
    raw.mainRootPostId !== mainRootPostId ||
    raw.inputPostId !== inputPostId ||
    raw.activityRootPostId !== activityRootPostId
  ) {
    return undefined;
  }
  return {
    conversationId,
    turnId,
    runId,
    agentId,
    sessionKey,
    origin,
    mainChannelId,
    mainRootPostId,
    inputPostId,
    activityRootPostId,
  };
}

function sameRunIdentity(left: RecoveryRunRef, right: RecoveryRunRef): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.origin === right.origin &&
    left.mainChannelId === right.mainChannelId &&
    left.mainRootPostId === right.mainRootPostId &&
    left.inputPostId === right.inputPostId &&
    left.activityRootPostId === right.activityRootPostId
  );
}

function parseAnswerPart(value: unknown, index: number): RecoveryAnswerPart | undefined {
  const part = record(value);
  const postId = normalized(part?.postId);
  const kind = normalized(part?.kind);
  const rootPostId = normalized(part?.rootPostId);
  const threadId = normalized(part?.threadId);
  if (
    !part ||
    !postId ||
    !kind ||
    part.postId !== postId ||
    part.kind !== kind ||
    !ANSWER_PART_KINDS.has(kind) ||
    part.index !== index ||
    (part.rootPostId !== undefined && part.rootPostId !== rootPostId) ||
    (part.threadId !== undefined && part.threadId !== threadId)
  ) {
    return undefined;
  }
  return {
    postId,
    kind,
    index,
    ...(rootPostId ? { rootPostId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function parseAnswerCommitPost(params: {
  post: MattermostPost;
  channelId: string;
  sessionKey: string;
  agentId: string;
  botUserId: string;
}): RecoveryAnswerCommit | undefined {
  const { post } = params;
  const raw = record(record(post.props)?.octogee);
  const ref = parseRunRef(raw);
  const answer = record(raw?.answer);
  const terminalOutcome = normalized(answer?.terminalOutcome);
  const deliveryOutcome = normalized(answer?.deliveryOutcome);
  const postIds = answer?.postIds;
  const rawParts = answer?.parts;
  if (
    !raw ||
    !ref ||
    !answer ||
    raw.kind !== "agent.answer-commit" ||
    raw.itemId !== "octogee:answer-commit" ||
    raw.semanticVersion !== 1 ||
    finiteTimestamp(raw.ordinal) === undefined ||
    !normalized(raw.eventKey) ||
    raw.attention !== "routine" ||
    !terminalOutcome ||
    !TERMINAL_OUTCOMES.has(terminalOutcome) ||
    raw.status !== terminalOutcome ||
    answer.terminalOutcome !== terminalOutcome ||
    !deliveryOutcome ||
    !DELIVERY_OUTCOMES.has(deliveryOutcome) ||
    answer.deliveryOutcome !== deliveryOutcome ||
    !Array.isArray(postIds) ||
    !Array.isArray(rawParts) ||
    postIds.length !== rawParts.length ||
    rawParts.length > MAX_ANSWER_PARTS ||
    ref.agentId !== params.agentId ||
    ref.sessionKey !== params.sessionKey ||
    ref.origin !== "human" ||
    ref.conversationId !== params.channelId ||
    ref.mainChannelId !== params.channelId ||
    ref.turnId !== ref.mainRootPostId ||
    post.user_id !== params.botUserId ||
    post.channel_id !== params.channelId ||
    normalized(post.root_id) !== ref.mainRootPostId ||
    post.message !== "Answer committed" ||
    !isOrdinaryPost(post) ||
    !isZeroOrMissing(post.edit_at) ||
    finiteTimestamp(post.create_at) === undefined ||
    (Array.isArray(post.file_ids) ? post.file_ids.length !== 0 : post.file_ids != null)
  ) {
    return undefined;
  }
  const parts: RecoveryAnswerPart[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = parseAnswerPart(rawParts[index], index);
    if (
      !part ||
      postIds[index] !== part.postId ||
      seen.has(part.postId) ||
      (part.rootPostId !== undefined && part.rootPostId !== ref.mainRootPostId) ||
      (part.threadId !== undefined && part.threadId !== ref.mainRootPostId)
    ) {
      return undefined;
    }
    seen.add(part.postId);
    parts.push(part);
  }
  const requiresParts = deliveryOutcome === "delivered" || deliveryOutcome === "partial";
  if (requiresParts !== parts.length > 0) {
    return undefined;
  }
  return { post, ref, deliveryOutcome, parts };
}

function isHumanRootPost(params: {
  post: MattermostPost;
  channelId: string;
  botUserId: string;
}): boolean {
  return (
    Boolean(normalized(params.post.id)) &&
    Boolean(normalized(params.post.user_id)) &&
    params.post.user_id !== params.botUserId &&
    params.post.channel_id === params.channelId &&
    !normalized(params.post.root_id) &&
    finiteTimestamp(params.post.create_at) !== undefined &&
    isOrdinaryPost(params.post) &&
    postBody(params.post) !== undefined
  );
}

function isHumanThreadPost(params: {
  post: MattermostPost;
  root: MattermostPost;
  channelId: string;
  botUserId: string;
}): boolean {
  return (
    Boolean(normalized(params.post.id)) &&
    Boolean(normalized(params.post.user_id)) &&
    params.post.user_id !== params.botUserId &&
    params.post.channel_id === params.channelId &&
    (params.post.id === params.root.id
      ? !normalized(params.post.root_id)
      : normalized(params.post.root_id) === params.root.id) &&
    finiteTimestamp(params.post.create_at) !== undefined &&
    isOrdinaryPost(params.post) &&
    postBody(params.post) !== undefined
  );
}

function hasMatchingOptionalRunRef(post: MattermostPost, expected: RecoveryRunRef): boolean {
  const raw = record(post.props)?.octogee;
  if (raw === undefined) {
    return true;
  }
  const props = record(raw);
  const ref = parseRunRef(props);
  return Boolean(
    props &&
    ref &&
    props.kind === undefined &&
    props.itemId === undefined &&
    props.toolCallId === undefined &&
    sameRunIdentity(ref, expected),
  );
}

function isCommittedAnswerPost(params: {
  post: MattermostPost;
  part: RecoveryAnswerPart;
  commit: RecoveryAnswerCommit;
  channelId: string;
  botUserId: string;
}): boolean {
  const commitCreatedAt = finiteTimestamp(params.commit.post.create_at);
  const postCreatedAt = finiteTimestamp(params.post.create_at);
  const postEditedAt = isZeroOrMissing(params.post.edit_at)
    ? 0
    : finiteTimestamp(params.post.edit_at);
  return (
    commitCreatedAt !== undefined &&
    postCreatedAt !== undefined &&
    postEditedAt !== undefined &&
    postCreatedAt <= commitCreatedAt &&
    postEditedAt <= commitCreatedAt &&
    params.post.id === params.part.postId &&
    params.post.id !== params.commit.post.id &&
    params.post.user_id === params.botUserId &&
    params.post.channel_id === params.channelId &&
    normalized(params.post.root_id) === params.commit.ref.mainRootPostId &&
    isOrdinaryPost(params.post) &&
    postBody(params.post) !== undefined &&
    hasMatchingOptionalRunRef(params.post, params.commit.ref)
  );
}

function comparePosts(left: MattermostPost, right: MattermostPost): number {
  return (
    (finiteTimestamp(left.create_at) ?? 0) - (finiteTimestamp(right.create_at) ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function historyEntry(post: MattermostPost, sender: string): HistoryEntry | undefined {
  const body = postBody(post);
  if (!body) {
    return undefined;
  }
  const timestamp = finiteTimestamp(post.create_at);
  return {
    sender,
    body,
    ...(timestamp !== undefined ? { timestamp } : {}),
    messageId: post.id,
  };
}

function postBodies(posts: MattermostPost[]): string[] | undefined {
  const bodies: string[] = [];
  for (const post of posts) {
    const body = postBody(post);
    if (!body) {
      return undefined;
    }
    bodies.push(body);
  }
  return bodies;
}

function takeLatestGroups(groups: HistoryEntry[][], maxEntries: number): HistoryEntry[] {
  const selected: HistoryEntry[][] = [];
  let remaining = maxEntries;
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const group = groups[index] ?? [];
    if (group.length <= remaining) {
      selected.unshift(group);
      remaining -= group.length;
      continue;
    }
    const first = group[0];
    if (selected.length === 0 && first) {
      selected.unshift(remaining === 1 ? [first] : [first, ...group.slice(-(remaining - 1))]);
    }
    break;
  }
  return selected.flat();
}

function dedupePosts(posts: MattermostPost[]): {
  postsById: Map<string, MattermostPost>;
  conflictingIds: Set<string>;
} {
  const postsById = new Map<string, MattermostPost>();
  const conflictingIds = new Set<string>();
  for (const post of posts) {
    const postId = normalized(post.id);
    if (!postId) {
      continue;
    }
    if (postsById.has(postId)) {
      conflictingIds.add(postId);
      continue;
    }
    postsById.set(postId, post);
  }
  return { postsById, conflictingIds };
}

export function buildMattermostChannelRecoveryHistory(params: {
  posts: MattermostPost[];
  channelId: string;
  sessionKey: string;
  agentId: string;
  botUserId: string;
  maxEntries: number;
}): HistoryEntry[] {
  const { postsById, conflictingIds } = dedupePosts(params.posts);
  const roots = [...postsById.values()]
    .filter((post) => !conflictingIds.has(post.id) && isHumanRootPost({ post, ...params }))
    .toSorted(comparePosts);
  const parsedCommits = [...postsById.values()]
    .filter((post) => !conflictingIds.has(post.id))
    .flatMap((post) => {
      const commit = parseAnswerCommitPost({ post, ...params });
      return commit?.deliveryOutcome === "delivered" ? [commit] : [];
    });
  const commitCountByRun = new Map<string, number>();
  for (const commit of parsedCommits) {
    commitCountByRun.set(commit.ref.runId, (commitCountByRun.get(commit.ref.runId) ?? 0) + 1);
  }
  const validCommits: Array<{ commit: RecoveryAnswerCommit; posts: MattermostPost[] }> = [];
  for (const commit of parsedCommits.toSorted((left, right) =>
    comparePosts(left.post, right.post),
  )) {
    if (commitCountByRun.get(commit.ref.runId) !== 1) {
      continue;
    }
    const root = postsById.get(commit.ref.mainRootPostId);
    const input = postsById.get(commit.ref.inputPostId);
    if (
      !root ||
      !input ||
      conflictingIds.has(root.id) ||
      conflictingIds.has(input.id) ||
      !isHumanRootPost({ post: root, ...params }) ||
      !isHumanThreadPost({ post: input, root, ...params })
    ) {
      continue;
    }
    const answerPosts: MattermostPost[] = [];
    let invalidAnswerPart = false;
    for (const part of commit.parts) {
      const post = postsById.get(part.postId);
      if (
        !post ||
        conflictingIds.has(part.postId) ||
        !isCommittedAnswerPost({
          post,
          part,
          commit,
          channelId: params.channelId,
          botUserId: params.botUserId,
        })
      ) {
        invalidAnswerPart = true;
        break;
      }
      answerPosts.push(post);
    }
    if (invalidAnswerPart) {
      continue;
    }
    validCommits.push({ commit, posts: answerPosts });
  }
  const answerPostUseCount = new Map<string, number>();
  for (const candidate of validCommits) {
    for (const post of candidate.posts) {
      answerPostUseCount.set(post.id, (answerPostUseCount.get(post.id) ?? 0) + 1);
    }
  }
  const latestCommitByInput = new Map<
    string,
    { commit: RecoveryAnswerCommit; posts: MattermostPost[] }
  >();
  for (const candidate of validCommits) {
    if (candidate.posts.every((post) => answerPostUseCount.get(post.id) === 1)) {
      latestCommitByInput.set(candidate.commit.ref.inputPostId, candidate);
    }
  }
  const groups = roots.map((root) => {
    const timeline: Array<HistoryEntry & { sortId: string }> = [];
    for (const post of postsById.values()) {
      if (!conflictingIds.has(post.id) && isHumanThreadPost({ post, root, ...params })) {
        const sender = normalized(post.user_id);
        const entry = sender ? historyEntry(post, sender) : undefined;
        if (!entry) {
          continue;
        }
        timeline.push({
          ...entry,
          sortId: post.id,
        });
      }
    }
    for (const { commit, posts } of latestCommitByInput.values()) {
      if (commit.ref.mainRootPostId !== root.id) {
        continue;
      }
      const bodies = postBodies(posts);
      const timestamp = finiteTimestamp(commit.post.create_at);
      if (!bodies || timestamp === undefined) {
        continue;
      }
      timeline.push({
        sender: "OpenClaw",
        body: bodies.join("\n\n"),
        timestamp,
        messageId: posts[0]?.id,
        sortId: commit.post.id,
      });
    }
    timeline.sort(
      (left, right) =>
        (left.timestamp ?? 0) - (right.timestamp ?? 0) || left.sortId.localeCompare(right.sortId),
    );
    return timeline.map(({ sortId: _sortId, ...entry }) => entry);
  });
  return takeLatestGroups(groups, Math.max(0, Math.min(params.maxEntries, MAX_RECOVERY_ENTRIES)));
}

export async function recoverMattermostChannelSessionHistory(
  params: {
    cfg: OpenClawConfig;
    client: MattermostClient;
    threadSessionScope?: "thread" | "channel";
    chatKind: string;
    currentPost: MattermostPost;
    isControlCommand: boolean;
    channelId: string;
    sessionKey: string;
    agentId: string;
    botUserId: string;
    historyLimit: number;
  },
  dependencies: RecoveryDependencies = defaultDependencies,
): Promise<HistoryEntry[] | undefined> {
  const currentPostId = normalized(params.currentPost.id);
  const route = parseChannelSessionKey(params.sessionKey);
  if (
    params.threadSessionScope !== "channel" ||
    (params.chatKind !== "group" && params.chatKind !== "channel") ||
    !currentPostId ||
    params.currentPost.user_id === params.botUserId ||
    params.isControlCommand ||
    params.historyLimit <= 0 ||
    !route ||
    route.agentId !== params.agentId ||
    route.kind !== params.chatKind ||
    route.channelId !== params.channelId
  ) {
    return undefined;
  }
  if (
    dependencies.sessionExists({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    })
  ) {
    return undefined;
  }
  const page = await dependencies.fetchChannelPosts(params.client, params.channelId, {
    before: currentPostId,
    limit: RECOVERY_READ_LIMIT,
  });
  const posts = [...page.messages];
  const knownIds = new Set(posts.map((post) => post.id));
  const commits = posts
    .flatMap((post) => {
      const commit = parseAnswerCommitPost({ post, ...params });
      return commit?.deliveryOutcome === "delivered" ? [commit] : [];
    })
    .toSorted((left, right) => comparePosts(right.post, left.post));
  const missingIds = new Set<string>();
  const currentRootPostId = normalized(params.currentPost.root_id);
  if (currentRootPostId && !knownIds.has(currentRootPostId)) {
    missingIds.add(currentRootPostId);
  }
  for (const commit of commits) {
    for (const postId of [
      commit.ref.mainRootPostId,
      commit.ref.inputPostId,
      ...commit.parts.map((part) => part.postId),
    ]) {
      if (!knownIds.has(postId) && missingIds.size < MAX_REFERENCE_READS) {
        missingIds.add(postId);
      }
    }
    if (missingIds.size >= MAX_REFERENCE_READS) {
      break;
    }
  }
  const fetched = await Promise.all(
    [...missingIds].map((postId) => dependencies.fetchPost(params.client, postId)),
  );
  posts.push(...fetched);
  const history = buildMattermostChannelRecoveryHistory({
    posts,
    channelId: params.channelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    botUserId: params.botUserId,
    maxEntries: params.historyLimit,
  });
  return history.length > 0 ? history : undefined;
}
