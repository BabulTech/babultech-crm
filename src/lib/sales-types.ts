/**
 * Sales time is logged against a prospect, lead, deal or account. These are the
 * four, how each is named on screen, and where each opens.
 */
export const SALES_TYPES = ["Prospect", "Lead", "Opportunity", "Account"] as const;
export type SalesType = (typeof SALES_TYPES)[number];

export const SALES_TYPE_LABEL: Record<SalesType, string> = {
  Prospect: "Prospect", Lead: "Lead", Opportunity: "Deal", Account: "Account",
};

export const SALES_ACTIVITIES = [
  ["CALL", "Call"], ["EMAIL", "Email"], ["MEETING", "Meeting"],
  ["PROPOSAL", "Proposal"], ["RESEARCH", "Research"], ["FOLLOW_UP", "Follow-up"],
] as const;

export const salesHref = (type: string, id: string) =>
  ({ Prospect: `/prospects/${id}`, Lead: `/leads/${id}`, Opportunity: `/opportunities/${id}`, Account: `/accounts/${id}` } as Record<string, string>)[type] ?? null;

