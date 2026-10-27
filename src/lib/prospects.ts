/** Shared by the prospect screens and src/server/prospects.ts. */

/** Rows per page on the prospects list. */
export const PROSPECT_PAGE_SIZE = 50;

export const PROSPECT_STATUSES = ["ACTIVE", "QUALIFIED", "ARCHIVED"] as const;
export const PROSPECT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Being worked",
  QUALIFIED: "Qualified (now a lead)",
  ARCHIVED: "Archived",
};
