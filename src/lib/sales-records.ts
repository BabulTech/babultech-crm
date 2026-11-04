import { supabaseAdmin } from "./supabase";

import { SALES_TYPES, type SalesType } from "./sales-types";
export { SALES_TYPES, SALES_TYPE_LABEL, SALES_ACTIVITIES, salesHref, type SalesType } from "./sales-types";

const QUERIES: Record<SalesType, { table: string; columns: string; label: (r: Record<string, unknown>) => string }> = {
  Prospect: { table: "prospect", columns: "id, businessName", label: (r) => String(r.businessName ?? "Prospect") },
  Lead: {
    table: "lead", columns: "id, leadNumber, companyName, firstName, lastName",
    label: (r) => `${r.leadNumber} - ${r.companyName || [r.firstName, r.lastName].filter(Boolean).join(" ") || "Lead"}`,
  },
  Opportunity: { table: "opportunity", columns: "id, opportunityNumber, name", label: (r) => `${r.opportunityNumber} - ${r.name}` },
  Account: { table: "account", columns: "id, accountNumber, name", label: (r) => String(r.name) },
};

/** Names for a set of sales records, keyed "Type:id". */
export async function labelSalesRecords(refs: { type: string | null; id: string | null }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const admin = supabaseAdmin();
  for (const type of SALES_TYPES) {
    const ids = [...new Set(refs.filter((r) => r.type === type && r.id).map((r) => r.id!))];
    if (!ids.length) continue;
    const q = QUERIES[type];
    const { data } = await admin.from(q.table).select(q.columns).in("id", ids);
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) out.set(`${type}:${row.id}`, q.label(row));
  }
  return out;
}

/** The sales records someone works on: their own, open, most recent first. */
export async function salesOptionsFor(userId: string): Promise<{ type: SalesType; id: string; label: string }[]> {
  const admin = supabaseAdmin();
  const [prospects, leads, deals, accounts] = await Promise.all([
    admin.from("prospect").select(QUERIES.Prospect.columns).eq("ownerUserId", userId).is("deletedAt", null).order("updatedAt", { ascending: false }).limit(150),
    admin.from("lead").select(QUERIES.Lead.columns).eq("ownerUserId", userId).is("deletedAt", null).is("convertedAt", null).order("updatedAt", { ascending: false }).limit(150),
    admin.from("opportunity").select(QUERIES.Opportunity.columns).eq("ownerUserId", userId).is("deletedAt", null).not("stage", "in", '("CLOSED_WON","CLOSED_LOST")').order("updatedAt", { ascending: false }).limit(150),
    admin.from("account").select(QUERIES.Account.columns).eq("ownerUserId", userId).is("deletedAt", null).order("updatedAt", { ascending: false }).limit(150),
  ]);
  const rows = (type: SalesType, res: { data: unknown }) =>
    ((res.data ?? []) as Record<string, unknown>[]).map((r) => ({ type, id: String(r.id), label: QUERIES[type].label(r) }));
  return [...rows("Prospect", prospects), ...rows("Lead", leads), ...rows("Opportunity", deals), ...rows("Account", accounts)];
}

/** Whether a sales record exists and is not deleted. */
export async function salesRecordExists(type: string, id: string): Promise<boolean> {
  const q = QUERIES[type as SalesType];
  if (!q) return false;
  const { data } = await supabaseAdmin().from(q.table).select("id").eq("id", id).is("deletedAt", null).maybeSingle();
  return Boolean(data);
}
