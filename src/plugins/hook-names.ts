const PLUGIN_HOOK_NAMES = [
  "before_model_resolve",
  "agent_turn_prepare",
  "before_prompt_build",
  "before_agent_reply",
  "model_call_started",
  "model_call_ended",
  "llm_input",
  "llm_output",
  "before_agent_finalize",
  "agent_end",
  "before_compaction",
  "after_compaction",
  "before_reset",
  "inbound_claim",
  "channel_pairing_requested",
  "message_received",
  "message_sending",
  "reply_payload_sending",
  "message_sent",
  "before_tool_call",
  "after_tool_call",
  "tool_result_persist",
  "before_message_write",
  "session_start",
  "session_end",
  "subagent_delivery_target",
  "subagent_spawned",
  "subagent_progress",
  "subagent_ended",
  "gateway_start",
  "gateway_stop",
  "heartbeat_prompt_contribution",
  "cron_reconciled",
  "cron_changed",
  "skill_proposal_evaluate",
  "skill_proposal_changed",
  "skill_changed",
  "before_dispatch",
  "reply_dispatch",
  "before_install",
  "before_agent_run",
  "resolve_exec_env",
] as const;

export type PluginHookName = (typeof PLUGIN_HOOK_NAMES)[number];

const pluginHookNameSet = new Set<PluginHookName>(PLUGIN_HOOK_NAMES);

export const isPluginHookName = (hookName: unknown): hookName is PluginHookName =>
  typeof hookName === "string" && pluginHookNameSet.has(hookName as PluginHookName);

export const isPromptInjectionHookName = (hookName: PluginHookName): boolean =>
  hookName === "agent_turn_prepare" ||
  hookName === "before_prompt_build" ||
  hookName === "heartbeat_prompt_contribution";
