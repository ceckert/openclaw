import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
} from "../plugins/runtime.js";
import { isPlainObject } from "../utils.js";

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartHealthMonitor: boolean;
  reloadPlugins: boolean;
  restartChannels: Set<ChannelKind>;
  disposeMcpRuntimes: boolean;
  /**
   * Per-account surgical restart targets, keyed by channel kind. Populated
   * when all of a channel's changed paths are scoped under
   * `channels.{kind}.accounts.{accountId}[.*]` — the executor calls
   * `stopChannel(kind, accountId)` + `startChannel(kind, accountId)` for
   * each entry, leaving other accounts on that channel untouched.
   *
   * Mutual exclusion with `restartChannels`: if a channel appears in
   * `restartChannels` (wholesale restart), any per-account entries for
   * that channel are dropped — the wholesale restart covers them.
   *
   * **Octogee fork addition** (see forks doc). The existing channel
   * primitives already support an `accountId` parameter; this plan field
   * surfaces the scope information through the reload pipeline so the
   * executor actually uses it. On multi-tenant gateways (N coach accounts
   * per MM channel), this turns a new-customer signup from an N-customer
   * WS disconnect storm into a single per-account mount.
   */
  restartChannelAccounts: Map<ChannelKind, Set<string>>;
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-cron"
  | "restart-heartbeat"
  | "restart-health-monitor"
  | "reload-plugins"
  | "dispose-mcp-runtimes"
  | `restart-channel:${ChannelId}`;

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
};

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  {
    prefix: "gateway.channelHealthCheckMinutes",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  {
    prefix: "gateway.channelStaleEventThresholdMinutes",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  {
    prefix: "gateway.channelMaxRestartsPerHour",
    kind: "hot",
    actions: ["restart-health-monitor"],
  },
  // Stuck-session warning threshold is read by the diagnostics heartbeat loop.
  { prefix: "diagnostics.stuckSessionWarnMs", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.model",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "models.pricing",
    kind: "restart",
  },
  {
    prefix: "models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.list",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  { prefix: "mcp", kind: "hot", actions: ["dispose-mcp-runtimes"] },
  { prefix: "plugins.load", kind: "restart" },
  { prefix: "plugins.installs", kind: "restart" },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "agents", kind: "none" },
  { prefix: "tools", kind: "none" },
  { prefix: "bindings", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "secrets", kind: "none" },
  { prefix: "plugins", kind: "hot", actions: ["reload-plugins", "dispose-mcp-runtimes"] },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
  { prefix: "canvasHost", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedActiveRegistryVersion = -1;
let cachedChannelRegistryVersion = -1;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  const activeRegistryVersion = getActivePluginRegistryVersion();
  const channelRegistryVersion = getActivePluginChannelRegistryVersion();
  if (
    registry !== cachedRegistry ||
    activeRegistryVersion !== cachedActiveRegistryVersion ||
    channelRegistryVersion !== cachedChannelRegistryVersion
  ) {
    cachedReloadRules = null;
    cachedRegistry = registry;
    cachedActiveRegistryVersion = activeRegistryVersion;
    cachedChannelRegistryVersion = channelRegistryVersion;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) =>
    (plugin.reload?.configPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "hot",
          actions: [`restart-channel:${plugin.id}` as ReloadAction],
        }),
      )
      .concat(
        (plugin.reload?.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
  const channelPluginStateRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    {
      prefix: `plugins.entries.${plugin.id}`,
      kind: "hot",
      actions: [
        "reload-plugins",
        "dispose-mcp-runtimes",
        `restart-channel:${plugin.id}` as ReloadAction,
      ],
    },
  ]);
  const pluginReloadRules: ReloadRule[] = (registry?.reloads ?? []).flatMap((entry) =>
    (entry.registration.restartPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "restart",
        }),
      )
      .concat(
        (entry.registration.hotPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "hot",
          }),
        ),
        (entry.registration.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
  const rules = [
    ...BASE_RELOAD_RULES,
    ...pluginReloadRules,
    ...channelReloadRules,
    ...channelPluginStateRules,
    ...BASE_RELOAD_RULES_TAIL,
  ];
  cachedReloadRules = rules;
  return rules;
}

function matchRule(path: string): ReloadRule | null {
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
}

function isPluginInstallTimestampPath(path: string): boolean {
  // Legacy compatibility only: new plugin install metadata lives in the
  // managed plugin index, but old config writes may still touch this path.
  return /^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(path);
}

function getPluginInstallRecords(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {};
  }
  const plugins = config.plugins;
  if (!isPlainObject(plugins)) {
    return {};
  }
  // Keep legacy config install records out of gateway restart decisions while
  // migration/doctor moves them into the managed plugin index install records.
  const installs = plugins.installs;
  return isPlainObject(installs) ? installs : {};
}

export function listPluginInstallTimestampMetadataPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      continue;
    }
    for (const key of ["installedAt", "resolvedAt"] as const) {
      if (prevRecord[key] !== nextRecord[key]) {
        paths.push(`plugins.installs.${id}.${key}`);
      }
    }
  }

  return paths;
}

export function listPluginInstallWholeRecordPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      paths.push(`plugins.installs.${id}`);
    }
  }

  return paths;
}

/**
 * If `path` is scoped to a specific account on a given channel — matching
 * the shape `channels.{channel}.accounts.{accountId}` or
 * `channels.{channel}.accounts.{accountId}.{anything}` — return the
 * `accountId`. Otherwise return `null` (channel-global or not-a-channel
 * path). Empty accountId segments (`channels.mattermost.accounts..foo`)
 * also return null — malformed paths fall through to wholesale restart.
 *
 * **Octogee fork addition.**
 */
function extractAccountIdFromPath(channel: ChannelId, path: string): string | null {
  const prefix = `channels.${channel}.accounts.`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  const dotIdx = rest.indexOf(".");
  const id = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
  return id.length > 0 ? id : null;
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
  options: GatewayReloadPlanOptions = {},
): GatewayReloadPlan {
  const noopPaths = new Set(options.noopPaths);
  const forceChangedPaths = new Set(options.forceChangedPaths);
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    restartChannelAccounts: new Map(),
    noopPaths: [],
  };

  const applyAction = (action: ReloadAction, originatingPath: string) => {
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      const accountId = extractAccountIdFromPath(channel, originatingPath);
      if (accountId !== null) {
        // Octogee fork: route per-account changes to the surgical-restart
        // bucket. Executor calls stopChannel/startChannel with accountId,
        // leaving other accounts on this channel running untouched.
        let set = plan.restartChannelAccounts.get(channel);
        if (!set) {
          set = new Set<string>();
          plan.restartChannelAccounts.set(channel, set);
        }
        set.add(accountId);
        return;
      }
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      case "restart-health-monitor":
        plan.restartHealthMonitor = true;
        break;
      case "reload-plugins":
        plan.reloadPlugins = true;
        break;
      case "dispose-mcp-runtimes":
        plan.disposeMcpRuntimes = true;
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const isTimestampNoop =
      !forceChangedPaths.has(path) &&
      (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path));
    if (isTimestampNoop) {
      plan.noopPaths.push(path);
      continue;
    }
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action, path);
    }
  }

  // Octogee fork: if a channel is scheduled for wholesale restart, drop its
  // per-account entries — the wholesale restart covers them and running
  // both would double-stop the targeted accounts. Preserves the invariant
  // "each (channel, account) pair is restarted at most once per plan".
  for (const channel of plan.restartChannels) {
    plan.restartChannelAccounts.delete(channel);
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}
