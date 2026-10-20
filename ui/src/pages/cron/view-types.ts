import type { buildCronViewProps } from "./view-props.ts";

type CronViewProps = ReturnType<typeof buildCronViewProps>;
type OptionalViewProp =
  | "eventSource"
  | "channelLabels"
  | "channelMeta"
  | "highlightedRunId"
  | "onViewRunTranscript"
  | "onRunMount";

export type CronProps = Omit<CronViewProps, OptionalViewProp> &
  Partial<Pick<CronViewProps, OptionalViewProp>> & {
    readOnlyReason?: string;
    canViewJobHistory?: (jobId: string) => boolean;
  };

export type CronPanelMode = "overview" | "create" | "job";
