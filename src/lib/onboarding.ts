export const PHASES = ["KICKOFF", "COLLECT", "SETUP", "TRAIN", "GO_LIVE", "FOLLOW_UP"] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABELS: Record<Phase, string> = { KICKOFF: "Kickoff", COLLECT: "Collect from customer", SETUP: "Set up", TRAIN: "Train", GO_LIVE: "Go live", FOLLOW_UP: "Follow-up" };
