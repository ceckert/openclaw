import { describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { createCronViewJob, getButtonByText, renderCronView } from "./view.test-support.ts";

const run = (jobId: string): CronRunLogEntry => ({
  ts: 1,
  jobId,
  action: "finished",
  status: "ok",
  runId: `run-${jobId}`,
});

describe("hosted cron read access", () => {
  it("uses the host read-only reason without enabling mutations", () => {
    const container = renderCronView({
      canManage: false,
      readOnlyReason: "Manage through your agent.",
    });
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      "Manage through your agent.",
    );
    expect(container.textContent).not.toContain("operator.admin");
    expect(container.querySelector('[data-test-id="cron-new-task"]')).toBeNull();
  });

  it("hides denied detail history even when it was already selected", () => {
    const container = renderCronView({
      editingJob: createCronViewJob("denied"),
      detailTab: "history",
      runs: [run("denied")],
      canViewJobHistory: () => false,
    });
    expect(container.querySelector('[data-test-id="cron-detail-tab-history"]')).toBeNull();
    expect(container.querySelector(".cron-runs")).toBeNull();
    expect(container.querySelector(".cron-editor")).not.toBeNull();
  });

  it("filters overview activity by run identity without changing server pagination", () => {
    const onLoadMoreRuns = vi.fn();
    const container = renderCronView({
      listTab: "activity",
      jobs: [],
      runs: [run("allowed"), run("denied")],
      canViewJobHistory: (id) => id === "allowed",
      runsHasMore: true,
      onLoadMoreRuns,
    });
    expect(container.querySelectorAll(".cron-run-entry")).toHaveLength(1);
    expect(container.querySelector(".cron-run-entry")?.textContent).toContain("allowed");
    const loadMore = container.querySelector<HTMLButtonElement>(".cron-load-more");
    expect(loadMore).not.toBeNull();
    loadMore?.click();
    expect(onLoadMoreRuns).toHaveBeenCalledOnce();
  });

  it("does not offer a transcript without a host handler", () => {
    const container = renderCronView({ listTab: "activity", runs: [run("job")] });
    expect(container.querySelector(".cron-run-entry button")).toBeNull();
  });

  it("rechecks history access for retained tab and transcript controls", () => {
    let allowed = true;
    const canViewJobHistory = () => allowed;
    const onDetailTabChange = vi.fn();
    const detail = renderCronView({
      editingJob: createCronViewJob("job"),
      canViewJobHistory,
      onDetailTabChange,
    });
    const onViewRunTranscript = vi.fn();
    const overview = renderCronView({
      listTab: "activity",
      runs: [run("job")],
      canViewJobHistory,
      onViewRunTranscript,
    });
    allowed = false;
    const history = detail.querySelector('[data-test-id="cron-detail-tab-history"]');
    expect(history).not.toBeNull();
    history?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    getButtonByText(overview, "View transcript").click();
    expect(onDetailTabChange).not.toHaveBeenCalled();
    expect(onViewRunTranscript).not.toHaveBeenCalled();
  });
});
