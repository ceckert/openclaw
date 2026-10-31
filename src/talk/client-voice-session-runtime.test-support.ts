import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

export const clientVoiceEntryRuntimeEntrypoint = createTestEntrypoint(
  import.meta.url,
  "talk",
)("client-voice-session-entry.postgres.test-support");

export const talkAgentConsultRuntimeEntrypoint = createTestEntrypoint(
  import.meta.url,
  "talk",
)("agent-consult.postgres.test-support");
