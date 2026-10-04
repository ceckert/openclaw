import { renderHubTabs } from "../../components/hub-tabs.ts";
import { t } from "../../i18n/index.ts";
import type { CronDetailTab, CronProps } from "./view-types.ts";

export function renderDetailTabs(props: CronProps) {
  return renderHubTabs<CronDetailTab>({
    id: "cron-detail",
    panelId: "cron-detail-panel",
    className: "cron-tabs",
    variant: "sub",
    active: props.detailTab,
    tabs: [
      {
        value: "settings",
        label: t("cron.detail.settingsTab"),
        testId: "cron-detail-tab-settings",
      },
      { value: "history", label: t("cron.detail.historyTitle"), testId: "cron-detail-tab-history" },
    ],
    ariaLabel: t("cron.detail.tabsLabel"),
    onSelect: (tab) => {
      const jobId = props.editingJob?.id;
      if (tab === "history" && (!jobId || props.canViewJobHistory?.(jobId) === false)) {
        return;
      }
      props.onDetailTabChange(tab);
    },
  });
}
