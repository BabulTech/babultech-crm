/** Shared by the proposal editor, the customer page and the server. */

export type TemplateSection =
  | { kind: "TEXT"; title: string; body: string }
  | { kind: "LIBRARY"; title: string; sectionId: string }
  | { kind: "PRICING"; title: string };

export interface PricingSnapshot {
  quoteNumber: string;
  currencyCode: string;
  lines: { description: string; quantity: number; unitPrice: number; discountPercent: number | null; lineTotal: number }[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentTerms: string | null;
}

/** A section of an actual proposal. Pricing is filled from the quotation; frozen when sent. */
export type ProposalSection =
  | { kind: "TEXT"; title: string; body: string }
  | { kind: "PRICING"; title: string; pricing?: PricingSnapshot | null };

export const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  VIEWED: "Viewed",
  CHANGES_REQUESTED: "Changes requested",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  SUPERSEDED: "Replaced by a newer version",
};

/** The fields a template can use, with what each becomes. Shown in the template editor. */
export const MERGE_FIELDS: { field: string; label: string }[] = [
  { field: "account.name", label: "Customer company" },
  { field: "contact.firstName", label: "Contact first name" },
  { field: "contact.fullName", label: "Contact full name" },
  { field: "opportunity.name", label: "Deal name" },
  { field: "opportunity.amount", label: "Deal value" },
  { field: "opportunity.currency", label: "Deal currency" },
  { field: "offering.name", label: "Offering" },
  { field: "owner.name", label: "Your name" },
  { field: "owner.title", label: "Your job title" },
  { field: "owner.email", label: "Your email" },
  { field: "owner.phone", label: "Your phone" },
  { field: "company.name", label: "Our company name" },
  { field: "today", label: "Today's date" },
  { field: "proposal.validUntil", label: "Valid until" },
];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Replaces {{field}} with values. Unknown fields are left as they are, so a typo shows. */
export function fillMergeFields(html: string, values: Record<string, string | null | undefined>): string {
  return html.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (whole, key: string) => {
    const v = values[key];
    return v == null || v === "" ? (key in values ? "" : whole) : escapeHtml(v);
  });
}

export function proposalDate(day: string | null | undefined): string {
  if (!day) return "";
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
