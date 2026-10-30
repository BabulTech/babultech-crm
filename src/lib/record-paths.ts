/**
 * Where each kind of record lives, and what to call it in a list - for
 * recently opened records and favourites.
 */
export const RECORD_PATHS: Record<string, string> = {
  Prospect: "/prospects/",
  Lead: "/leads/",
  Account: "/accounts/",
  Contact: "/contacts/",
  Opportunity: "/opportunities/",
  SupportCase: "/cases/",
  Project: "/projects/",
  Quotation: "/quotations/",
  Campaign: "/campaigns/",
  Partner: "/partners/",
  Invoice: "/invoices/",
};

export const RECORD_TYPE_LABEL: Record<string, string> = {
  Prospect: "Prospect",
  Lead: "Lead",
  Account: "Account",
  Contact: "Contact",
  Opportunity: "Deal",
  SupportCase: "Case",
  Project: "Project",
  Quotation: "Quote",
  Campaign: "Campaign",
  Partner: "Partner",
  Invoice: "Invoice",
};
