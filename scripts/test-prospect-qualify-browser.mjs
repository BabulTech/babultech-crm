// Prospecting, phase 3 - Qualify as lead, in a real browser.
//
// An admin qualifies a prospect in a campaign: a CRM lead is created with the
// chosen decision maker as its name, the business's phone, and the outreach
// history; the lead's page shows where it came from; the prospect is marked
// Qualified and Won in its campaign. A marketing user with Prospecting
// permissions but no sales permission can qualify too. Everything is
// temporary and removed afterwards.
//
// Usage: node scripts/test-prospect-qualify-browser.mjs http://localhost:3100
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

config({ path: ".env", quiet: true });
const base = process.argv[2] || "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("This check only targets the local application.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const run = randomUUID().slice(0, 6).toUpperCase();
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
const ids = { users: [], role: randomUUID(), dataset: null, campaign: null, prospects: [], leads: [] };
let browser;

async function makeUser(name, roleId) {
  const email = `qualify-${name}-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  const { error } = await db.from("app_user").insert({ id: auth.data.user.id, fullName: `QA ${name} ${run}`, email, roleId, status: "ACTIVE", updatedAt: new Date().toISOString() });
  if (error) throw new Error(error.message);
  ids.users.push(auth.data.user.id);
  return { id: auth.data.user.id, email, password };
}

async function signIn(user) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });
  return page;
}

async function makeProspect(name, phone) {
  const p = (await db.from("prospect").insert({ businessName: name, datasetId: ids.dataset, website: "https://qa.example.com", industry: "Dentist", region: "GTA", icpTier: "A - Core" }).select("id").single()).data;
  ids.prospects.push(p.id);
  await db.from("prospect_phone").insert({ prospectId: p.id, phone, isPrimary: true });
  const person = (await db.from("prospect_person").insert({ prospectId: p.id, name: `Jane QA${run} Smith`, role: "Owner", isPrimary: true }).select("id").single()).data;
  await db.from("prospect_campaign_entry").insert({ campaignId: ids.campaign, prospectId: p.id, status: "replied", touchCount: 2 });
  await db.from("prospect_activity").insert({ prospectId: p.id, campaignId: ids.campaign, type: "CALL_CONNECTED", channel: "business_phone", personId: person.id, content: `Wants a demo next week ${run}` });
  return p.id;
}

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  await db.from("security_role").insert({ id: ids.role, name: `QA Marketer ${run}`, permissions: ["prospect:read", "prospect:write", "prospect:qualify"], dataScope: "OWN", updatedAt: new Date().toISOString() });
  const admin = await makeUser("admin", crm.id);
  const marketer = await makeUser("marketer", ids.role);
  ids.dataset = (await db.from("prospect_dataset").insert({ name: `QA qualify ${run}` }).select("id").single()).data.id;
  // Linked to an existing marketing campaign; the lead credited to it is removed afterwards.
  const marketing = (await db.from("campaign").select("id, name").is("deletedAt", null).limit(1).single()).data;
  ids.campaign = (await db.from("prospect_campaign").insert({ name: `QA Qualify Campaign ${run}`, ownerUserId: admin.id, marketingCampaignId: marketing.id }).select("id").single()).data.id;
  const digits = String(Date.now()).slice(-7);
  const first = await makeProspect(`QA Qualify ${run} One`, `+1 905 ${digits.slice(0, 3)} ${digits.slice(3)}`);
  const second = await makeProspect(`QA Qualify ${run} Two`, `+1 289 ${digits.slice(0, 3)} ${digits.slice(3)}`);

  browser = await chromium.launch({ headless: true });

  // An admin qualifies; the new lead opens.
  const page = await signIn(admin);
  await page.goto(`${base}/prospects/${first}?campaign=${ids.campaign}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Qualify as lead" }).click();
  await page.locator('select[name="ownerUserId"]').selectOption(admin.id);
  assert.notEqual(await page.locator('select[name="personId"]').inputValue(), "", "The main contact is chosen for you");
  await page.locator('textarea[name="note"]').fill("Ready for a demo");
  await page.getByRole("button", { name: "Create the lead" }).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30000 });
  const leadId = page.url().split("/leads/")[1].split("?")[0];
  ids.leads.push(leadId);
  const lead = (await db.from("lead").select("*").eq("id", leadId).single()).data;
  assert.equal(lead.firstName, "Jane");
  assert.equal(lead.lastName, `QA${run} Smith`);
  assert.equal(lead.companyName, `QA Qualify ${run} One`);
  assert.equal(lead.jobTitle, "Owner");
  assert.ok(lead.phone.startsWith("+1 905"));
  assert.equal(lead.ownerUserId, admin.id);
  assert.equal(lead.status, "NEW");
  assert.equal(lead.leadSource, `Prospecting - QA Qualify Campaign ${run}`);
  assert.ok(lead.description.includes(`Wants a demo next week ${run}`) && lead.description.includes("Ready for a demo"));
  assert.equal(lead.campaignId, marketing.id, "Credited to the linked marketing campaign");
  pass("Qualifying creates the lead with the decision maker, the phone, the owner and the outreach history, credited to the linked marketing campaign, and opens it");

  await page.goto(`${base}/prospects/campaigns/${ids.campaign}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: marketing.name, exact: true }).first().waitFor();
  await page.getByRole("link", { name: "Marketing campaigns", exact: true }).waitFor();
  pass("The outreach campaign shows its marketing campaign, and the sidebar says Marketing campaigns");
  await page.goto(`${base}/leads/${leadId}`, { waitUntil: "networkidle" });

  await page.getByText("From prospecting", { exact: true }).waitFor();
  await page.getByRole("link", { name: `QA Qualify ${run} One` }).waitFor();
  pass("The lead's page shows which prospect it came from");

  const after = (await db.from("prospect").select("status, \"qualifiedLeadId\"").eq("id", first).single()).data;
  const entry = (await db.from("prospect_campaign_entry").select("status").eq("prospectId", first).single()).data;
  assert.equal(after.status, "QUALIFIED");
  assert.equal(after.qualifiedLeadId, leadId);
  assert.equal(entry.status, "won");
  await page.goto(`${base}/prospects/${first}`, { waitUntil: "networkidle" });
  await page.getByText(`handed to sales as`).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Qualify as lead" }).count(), 0);
  pass("The prospect is marked Qualified and Won, links to the lead, and cannot be qualified twice");

  // A marketer without sales permissions qualifies too.
  const mpage = await signIn(marketer);
  await mpage.goto(`${base}/prospects/${second}?campaign=${ids.campaign}`, { waitUntil: "networkidle" });
  await mpage.getByRole("button", { name: "Qualify as lead" }).click();
  await mpage.locator('select[name="ownerUserId"]').selectOption(admin.id);
  await mpage.getByRole("button", { name: "Create the lead" }).click();
  await mpage.getByText(/Qualified and handed to sales as LEAD-/).waitFor({ timeout: 30000 });
  const second_ = (await db.from("prospect").select("\"qualifiedLeadId\"").eq("id", second).single()).data;
  assert.ok(second_.qualifiedLeadId);
  ids.leads.push(second_.qualifiedLeadId);
  pass("A marketing user with no sales permission can qualify, and is told the lead number");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of ids.leads) {
    await db.from("note").delete().eq("relatedEntityId", id);
    await db.from("audit_history").delete().eq("entityId", id);
  }
  if (ids.campaign) await db.from("prospect_campaign").delete().eq("id", ids.campaign);
  if (ids.prospects.length) await db.from("prospect").delete().in("id", ids.prospects);
  if (ids.leads.length) await db.from("lead").delete().in("id", ids.leads);
  if (ids.dataset) await db.from("prospect_dataset").delete().eq("id", ids.dataset);
  for (const id of ids.users) {
    await db.from("prospect_task").delete().eq("createdById", id);
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", id);
    await db.from("audit_history").delete().eq("changedById", id);
    await db.from("app_user").delete().eq("id", id);
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  await db.from("security_role").delete().eq("id", ids.role);
  console.log("Temporary data removed.");
}
