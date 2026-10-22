// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveSessionContextLimit } from "./context-budget.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

function row(fields: Partial<GatewaySessionRow>): GatewaySessionRow {
  return { key: "agent:main:preview", kind: "direct", sessionId: "preview", ...fields };
}

function promptBudget(provider: string, model: string, contextTokenBudget: number) {
  return {
    schemaVersion: 1 as const,
    source: "pre-prompt-estimate" as const,
    updatedAt: 1,
    provider,
    model,
    sessionId: "preview",
    route: "fits" as const,
    shouldCompact: false,
    estimatedPromptTokens: 1_000,
    contextTokenBudget,
    promptBudgetBeforeReserve: contextTokenBudget - 20_000,
    reserveTokens: 20_000,
    effectiveReserveTokens: 20_000,
    remainingPromptBudgetTokens: contextTokenBudget - 21_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
  };
}

describe("session row provenance", () => {
  it("retains omitted assistant enrichment but respects explicit clearing receipts", () => {
    const provenance = createSessionRowProvenance();
    const initial = row({
      snapshotAt: 10,
      lastAssistantMessage: { text: "Earlier reply", timestamp: 9 },
    });
    provenance.observeReadRow(initial, 1);
    const compact = row({ rowMode: "compact", snapshotAt: 20 });
    provenance.observeReadRow(compact, 2);
    const merged = provenance.mergeRow(initial, compact);
    expect(merged.lastAssistantMessage).toEqual({ text: "Earlier reply", timestamp: 9 });
    const cleared = { ...compact, snapshotAt: 30 };
    provenance.observeReadRow(cleared, 3);
    provenance.observeClears(cleared, ["lastAssistantMessage"]);
    expect(provenance.mergeRow(merged, cleared).lastAssistantMessage).toBeUndefined();
  });

  it("retains the sampling time of an unchanged accepted row", () => {
    const provenance = createSessionRowProvenance();
    const initial = row({ label: "Current", snapshotAt: 100 });
    provenance.observeReadRow(initial, 1);
    const newer = { ...initial, snapshotAt: 200 };
    provenance.observeReadRow(newer, 2);
    const accepted = provenance.mergeRow(initial, newer);
    expect(accepted.snapshotAt).toBe(200);
    const cached = { ...initial, label: "Earlier", snapshotAt: 150 };
    provenance.observeReadRow(cached, 3);
    expect(provenance.mergeRow(accepted, cached).label).toBe("Current");
  });

  it.each([
    ["descriptor-first", "compact"],
    ["compact-first", "compact"],
    ["descriptor-first", "dashboard"],
    ["compact-first", "dashboard"],
    ["descriptor-first", "sidebar"],
    ["compact-first", "sidebar"],
  ] as const)(
    "retains detail facts across %s %s reads and lets full reads clear them",
    (order, rowMode) => {
      const provenance = createSessionRowProvenance();
      const details = {
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
        ...(rowMode !== "compact" ? { model: "test-model", totalTokens: 123 } : {}),
      };
      const expectedDetails = structuredClone(details);
      const descriptor = row({
        ...details,
        updatedAt: 100,
        snapshotAt: 100,
        label: "Before",
      });
      const compact = row({ rowMode, updatedAt: 200, snapshotAt: 200, label: "Current" });
      const reads: [GatewaySessionRow, GatewaySessionRow] =
        order === "descriptor-first" ? [descriptor, compact] : [compact, descriptor];
      provenance.observeReadRow(reads[0], 1);
      provenance.observeReadRow(reads[1], 2);
      const merged = provenance.mergeRow(reads[0], reads[1]);
      expect(merged).toMatchObject({ label: "Current", ...expectedDetails });

      const cleared = row({ updatedAt: 300, snapshotAt: 300, label: "Current" });
      provenance.observeReadRow(cleared, 3);
      const next = provenance.mergeRow(merged, cleared);
      expect(next.thinkingLevels).toBeUndefined();
      expect(next.toolOverrides).toBeUndefined();
      expect(next.model).toBeUndefined();
      expect(next.totalTokens).toBeUndefined();
      expect(next.rowMode).toBeUndefined();
    },
  );

  it.each([
    ["switched", "minimax", "MiniMax-M3", 1_000_000, 1_000_000],
    ["unchanged", "deepseek", "deepseek-v4-flash", 128_000, 108_000],
  ] as const)(
    "inherits an omitted prompt budget only for its own model when the selection is %s",
    (_selection, modelProvider, model, contextTokens, expectedLimit) => {
      const provenance = createSessionRowProvenance();
      const previous = row({
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
        contextTokens: 128_000,
        contextBudgetStatus: promptBudget("deepseek", "deepseek-v4-flash", 128_000),
        updatedAt: 100,
        snapshotAt: 100,
      });
      const compact = row({
        rowMode: "compact",
        modelProvider,
        model,
        contextTokens,
        updatedAt: 200,
        snapshotAt: 200,
      });
      provenance.observeReadRow(previous, 1);
      provenance.observeReadRow(compact, 2);
      const merged = provenance.mergeRow(previous, compact);
      expect(resolveSessionContextLimit(merged).tokens).toBe(expectedLimit);
    },
  );
});
