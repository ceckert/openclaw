import { expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import { registerRuntimeConfigWriteListener } from "../../config/runtime-snapshot.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDeletionCron } from "./agents-delete.fixture.test-support.js";
import { detachGatewayAgents } from "./agents-detach-batch.js";

it("detaches all requested agents with one config write and completed store-preserving journals", async () => {
  await withOpenClawTestState({ label: "agent-detach-batch" }, async (state) => {
    await state.writeConfig({
      agents: {
        ownership: "explicit",
        entries: { keeper: {}, traveler: {}, worker: {} },
      },
      bindings: [
        { agentId: "traveler", match: { channel: "mattermost", accountId: "traveler" } },
        { agentId: "worker", match: { channel: "mattermost", accountId: "worker" } },
        { agentId: "keeper", match: { channel: "mattermost", accountId: "keeper" } },
      ],
    });
    await captureRuntimeConfigAsyncReader()();
    await loadUnfinishedDeliveries(state.stateDir);
    const { context, stop } = createDeletionCron(state);
    const write = vi.fn();
    const unsubscribe = registerRuntimeConfigWriteListener(write);
    try {
      await expect(detachGatewayAgents(["traveler", "worker"], context)).resolves.toMatchObject({
        configWritten: true,
        results: [
          { ok: true, agentId: "traveler", removedBindings: 1, removed: [], failed: [] },
          { ok: true, agentId: "worker", removedBindings: 1, removed: [], failed: [] },
        ],
      });
      expect(write).toHaveBeenCalledOnce();
      expect(Object.keys(getRuntimeConfig().agents?.entries ?? {})).toEqual(["keeper"]);
      expect(getRuntimeConfig().bindings).toEqual([
        { agentId: "keeper", match: { channel: "mattermost", accountId: "keeper" } },
      ]);
      for (const agentId of ["traveler", "worker"]) {
        expect(readAgentDeletionJournal(agentId)).toMatchObject({
          phase: "detach-retiring",
          deleteFiles: false,
          cleanupCompleted: true,
        });
      }
    } finally {
      unsubscribe();
      await stop();
    }
  });
});

it("rolls back fresh batch fences when a later agent has pending destructive cleanup", async () => {
  await withOpenClawTestState({ label: "agent-detach-batch-refused" }, async (state) => {
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { keeper: {}, traveler: {}, worker: {} } },
    });
    await captureRuntimeConfigAsyncReader()();
    await loadUnfinishedDeliveries(state.stateDir);
    beginAgentDeletionJournal(
      {
        agentId: "worker",
        operationId: "pending-delete",
        agentDir: state.agentDir("worker"),
        workspaceDir: state.path("worker"),
        sessionsDir: state.sessionsDir("worker"),
        deleteFiles: true,
        phase: "draining",
      },
      { env: state.env },
    );
    const { context, stop } = createDeletionCron(state);
    const write = vi.fn();
    const unsubscribe = registerRuntimeConfigWriteListener(write);
    try {
      await expect(detachGatewayAgents(["traveler", "worker"], context)).rejects.toThrow(
        'Agent "worker" has a pending deletion',
      );
      expect(write).not.toHaveBeenCalled();
      expect(readAgentDeletionJournal("traveler")).toBeUndefined();
      expect(readAgentDeletionJournal("worker")).toMatchObject({
        operationId: "pending-delete",
        phase: "draining",
        deleteFiles: true,
        cleanupCompleted: false,
      });
      expect(Object.keys(getRuntimeConfig().agents?.entries ?? {})).toEqual([
        "keeper",
        "traveler",
        "worker",
      ]);
    } finally {
      unsubscribe();
      await stop();
    }
  });
});
