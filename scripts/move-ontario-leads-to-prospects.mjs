// One-off, 27 Oct 2026: the Ontario ICP list was imported as leads, but it is
// raw prospecting data. This moves every untouched lead from that list into
// Prospecting (dataset "Ontario ICP") and then removes the lead. A lead that
// anyone has worked - status changed, notes, activities, history - is left
// alone. Writes a JSON backup of the leads it removes first.
//
// Usage: node scripts/move-ontario-leads-to-prospects.mjs <backup.json> [--apply]
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

config({ path: ".env", quiet: true });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const backupPath = process.argv[2];
const apply = process.argv.includes("--apply");
if (!backupPath) throw new Error("Give a path for the backup file.");

const SOURCE = "Google Maps - Ontario ICP";
const nameNorm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || null;
const websiteNorm = (s) => (s ? String(s).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "") || null : null);
const phoneNorm = (s) => (s ? String(s).replace(/\D/g, "") || null : null);

async function all(table, select, build) {
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db.from(table).select(select)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows = rows.concat(data);
    if (data.length < 1000) return rows;
  }
}

const leads = await all("lead", "*", (q) => q.or(`leadSource.eq.${SOURCE},status.eq.PROSPECT`).is("deletedAt", null).order("createdAt"));
const ids = new Set(leads.map((l) => l.id));
const touched = new Set();
for (const [table, column, type] of [["note", "relatedEntityId", "Lead"], ["activity", "relatedEntityId", "Lead"], ["audit_history", "entityId", "Lead"]]) {
  const rows = await all(table, column, (q) => q.eq(table === "audit_history" ? "entityType" : "relatedEntityType", type));
  for (const r of rows) if (ids.has(r[column])) touched.add(r[column]);
}
for (const table of ["lead_handoff", "campaign_member"]) {
  const rows = await all(table, "leadId", (q) => q.not("leadId", "is", null));
  for (const r of rows) if (ids.has(r.leadId)) touched.add(r.leadId);
}
const moving = leads.filter((l) => !touched.has(l.id) && (l.status === "NEW" || l.status === "PROSPECT"));
console.log({ candidates: leads.length, worked: touched.size, notNew: leads.filter((l) => !["NEW", "PROSPECT"].includes(l.status)).length, moving: moving.length, apply });
if (!apply) process.exit(0);

writeFileSync(backupPath, JSON.stringify(moving));

let { data: dataset } = await db.from("prospect_dataset").select("id").ilike("name", "Ontario ICP").is("deletedAt", null).maybeSingle();
if (!dataset) {
  const created = await db.from("prospect_dataset").insert({ name: "Ontario ICP", description: "Google Maps businesses in Ontario, matched against our ideal customer profile. Moved from Leads on 27 Oct 2026." }).select("id").single();
  if (created.error) throw new Error(created.error.message);
  dataset = created.data;
}

let moved = 0;
for (let i = 0; i < moving.length; i += 500) {
  const batch = moving.slice(i, i + 500);
  const prospects = [], phones = [], emails = [];
  for (const l of batch) {
    const id = randomUUID();
    const business = l.companyName || [l.firstName, l.lastName].filter((x) => x && x !== "—").join(" ") || "Unnamed";
    const custom = {};
    if (l.leadList) custom["Lead list"] = l.leadList;
    if (l.description) custom["Comments"] = l.description;
    prospects.push({
      id, businessName: business, nameNorm: nameNorm(business), website: l.website, websiteNorm: websiteNorm(l.website),
      industry: l.industry, street: l.street, city: l.city, region: l.region ?? l.state, country: l.country,
      icpTier: l.icpTier, googleRating: l.googleRating, googleReviewCount: l.googleReviewCount, googleMapsUrl: l.googleMapsUrl,
      tags: l.leadList ? [l.leadList] : [], customFields: custom, datasetId: l.leadSource === SOURCE ? dataset.id : null,
      source: l.leadSource, ownerUserId: l.ownerUserId, createdAt: l.createdAt, updatedAt: new Date().toISOString(),
    });
    if (l.phone) phones.push({ prospectId: id, phone: l.phone, phoneNorm: phoneNorm(l.phone), phoneClass: l.phoneClass, phoneType: l.phoneType, isPrimary: true });
    if (l.whatsapp && phoneNorm(l.whatsapp) !== phoneNorm(l.phone)) phones.push({ prospectId: id, phone: l.whatsapp, phoneNorm: phoneNorm(l.whatsapp), label: "WhatsApp" });
    if (l.email) emails.push({ prospectId: id, email: l.email, emailNorm: l.email.toLowerCase().trim(), isPrimary: true });
  }
  for (const [table, rows] of [["prospect", prospects], ["prospect_phone", phones], ["prospect_email", emails]]) {
    if (!rows.length) continue;
    const { error } = await db.from(table).insert(rows);
    if (error) throw new Error(`Batch at ${i}, ${table}: ${error.message}`);
  }
  // Only now that the prospects exist are their leads removed.
  const { error } = await db.from("lead").delete().in("id", batch.map((l) => l.id));
  if (error) throw new Error(`Batch at ${i}, removing leads: ${error.message}`);
  moved += batch.length;
  console.log(`  ${moved} moved`);
}
console.log({ moved, dataset: dataset.id });
