export const PHASES = ["KICKOFF", "COLLECT", "SETUP", "TRAIN", "GO_LIVE", "FOLLOW_UP"] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABELS: Record<Phase, string> = { KICKOFF: "Kickoff", COLLECT: "Collect from customer", SETUP: "Set up", TRAIN: "Train", GO_LIVE: "Go live", FOLLOW_UP: "Follow-up" };

export const STEP_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "WAITING_ON_CUSTOMER", "ON_HOLD", "COMPLETED", "NOT_REQUIRED"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  NOT_STARTED: "Not started", IN_PROGRESS: "In progress", WAITING_ON_CUSTOMER: "Waiting on customer",
  ON_HOLD: "On hold", COMPLETED: "Completed", NOT_REQUIRED: "Not required",
};
export const STEP_STATUS_TONES: Record<StepStatus, "neutral" | "info" | "warning" | "danger" | "success"> = {
  NOT_STARTED: "neutral", IN_PROGRESS: "info", WAITING_ON_CUSTOMER: "warning", ON_HOLD: "danger", COMPLETED: "success", NOT_REQUIRED: "neutral",
};
export const isStepFinished = (status: string) => status === "COMPLETED" || status === "NOT_REQUIRED";
