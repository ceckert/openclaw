import "../test-utils/prepare-compiled-subprocesses.js";
import { registerGatewayThreadDatabaseProbeTests } from "../../test/helpers/gateway-thread-database-probe.js";
import { talkAgentConsultRuntimeEntrypoint } from "./client-voice-session-runtime.test-support.js";

registerGatewayThreadDatabaseProbeTests({
  suiteName: "Talk agent consult on the Gateway thread",
  testName: "runs a voice-bound agent consult on %s without admitting host SQL",
  dirPrefix: "talk-consult-gateway-",
  entrypoint: talkAgentConsultRuntimeEntrypoint,
  connectionEnv: "OPENCLAW_TEST_TALK_CONSULT_PG_CONNECTION",
  failureReason: "Talk agent consult failed",
  successPrefix: "Talk agent consult passed on the Gateway thread: ",
});
