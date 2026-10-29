/**
 * The kinds of record whose page can carry an Email button, and what each
 * needs. Safe for the browser. The server side (who may send, the
 * suggested recipients) is in src/server/email-anywhere.ts.
 */

// docType is the name the record's Documents panel files things under, so
// attachments sent from here show up there too.
export const EMAIL_SCREENS = {
  Prospect: { label: "Prospect", permission: "prospect:write", docType: "Prospect", path: (id: string) => `/prospects/${id}` },
  Lead: { label: "Lead", permission: "lead:write", docType: "Lead", path: (id: string) => `/leads/${id}` },
  CampaignMember: { label: "Campaign member", permission: "lead:write", docType: "CampaignMember", path: (id: string) => `/campaign-members/${id}` },
  Contact: { label: "Contact", permission: "account:write", docType: "Contact", path: (id: string) => `/contacts/${id}` },
  Account: { label: "Customer account", permission: "account:write", docType: "Account", path: (id: string) => `/accounts/${id}` },
  Opportunity: { label: "Deal", permission: "opportunity:write", docType: "Opportunity", path: (id: string) => `/opportunities/${id}` },
  Quotation: { label: "Quotation", permission: "opportunity:write", docType: "Quotation", path: (id: string) => `/quotations/${id}` },
  Invoice: { label: "Invoice", permission: "invoice:write", docType: "Invoice", path: (id: string) => `/invoices/${id}` },
  Project: { label: "Project", permission: "project:write", docType: "Project", path: (id: string) => `/projects/${id}` },
  Case: { label: "Support case", permission: "case:write", docType: "SupportCase", path: (id: string) => `/cases/${id}` },
  Partner: { label: "Partner", permission: "partner:write", docType: "Partner", path: (id: string) => `/partners/${id}` },
  Person: { label: "HR person", permission: "people:write", docType: "StaffProfile", path: (id: string) => `/people/${id}` },
  User: { label: "User", permission: "admin:*", docType: "User", path: (id: string) => `/users/${id}` },
} as const;

export type EmailScreen = keyof typeof EMAIL_SCREENS;

export function isEmailScreen(value: unknown): value is EmailScreen {
  return typeof value === "string" && value in EMAIL_SCREENS;
}

/** Total size of attachments on one email. */
export const EMAIL_ATTACHMENT_LIMIT = 10 * 1024 * 1024;

/** Emails one person may send in a day from record pages. */
export const DAILY_SEND_LIMIT = 200;

/** Puts {placeholders} into a subject or body. Unknown ones are left as written. */
export function fillEmailPlaceholders(template: string, values: Record<string, string>, html: boolean): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => (name in values ? (html ? esc(values[name]) : values[name]) : whole));
}

export const EMAIL_PLACEHOLDERS = [
  { name: "firstName", meaning: "The recipient's first name" },
  { name: "fullName", meaning: "The recipient's full name" },
  { name: "company", meaning: "Their company or business" },
  { name: "myName", meaning: "Your name" },
  { name: "myTitle", meaning: "Your job title" },
];
