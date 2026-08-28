import type {
  MattermostAdmissionActiveRun,
  MattermostAdmissionInput,
  MattermostAdmissionPolicy,
} from "./admission-types.js";

export function classifyMattermostAdmission(params: {
  input: Pick<MattermostAdmissionInput, "rootId">;
  activeRun?: Pick<MattermostAdmissionActiveRun, "mainRootPostId">;
}): MattermostAdmissionPolicy {
  if (!params.activeRun) {
    return "start";
  }
  return params.input.rootId === params.activeRun.mainRootPostId ? "steer" : "followup";
}
