import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";

const fixture = usePreparedModelRuntimeHarness({ label: "startup-scoped-model-publication" });

it("keeps Gateway startup alive when agent admission replaces its model preparation", async () => {
  fixture.mocks.configuredAgentIds = ["default"];
  const config = {};
  const acquisitionStarted = createDeferred();
  const releaseAcquisition = createDeferred();
  fixture.mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
    acquisitionStarted.resolve();
    await releaseAcquisition.promise;
    return {};
  });
  const startup = publishConfiguredModelRuntimeSnapshots({ cfg: config });
  const startupOutcome = Promise.allSettled([startup]);
  let admission: Promise<void> | undefined;
  try {
    await acquisitionStarted.promise;
    admission = refreshPreparedModelRuntimeSnapshots(config, {
      agentIds: new Set(["default"]),
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      isPublicationCurrent: () => true,
    });
    releaseAcquisition.resolve();
    await admission;
    expect((await startupOutcome)[0]).toEqual({ status: "fulfilled", value: undefined });
    await expect(
      prepareModelRuntimeSnapshot(fixture.agentInput("default", config)),
    ).resolves.toMatchObject({ agentId: "default", config });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default", config });
  } finally {
    releaseAcquisition.resolve();
    await Promise.allSettled([startup, admission]);
  }
});
