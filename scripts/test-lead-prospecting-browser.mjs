// Prospecting fields on leads - in a real browser.
//
// The leads list filters by ICP tier, region and lead list, and searches by
// phone; a lead's page shows its Prospecting card; the edit form saves the
// fields. Only a temporary lead is edited, and it is removed afterwards.
//
// Usage: node scripts/test-lead-prospecting-browser.mjs http://localhost:3100
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
let browser;
let userId = null;
let leadId = null;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `prosp-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  userId = auth.data.user.id;
  const ins = await db.from("app_user").insert({ id: userId, fullName: `QA prospecting ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });
  if (ins.error) throw new Error(ins.error.message);

  const phone = `+1 555-${run.slice(0, 3).replace(/\D/g, "7").padEnd(3, "7")}-${String(Date.now()).slice(-4)}`;
  const created = await db.rpc("create_record", {
    p_table: "lead",
    p_payload: {
      firstName: `QA Reno ${run}`, lastName: "—", companyName: `QA Reno ${run}`, phone, ownerUserId: userId, status: "NEW",
      icpTier: "A - Core (design/renovation)", region: "GTA", leadList: "Phone and website", googleRating: 4.6, googleReviewCount: 23,
      googleMapsUrl: "https://www.google.com/maps/place/QA", phoneClass: "Canadian/US", updatedAt: new Date().toISOString(),
    },
    p_number_field: "leadNumber", p_sequence: "Lead",
  });
  if (created.error) throw new Error(created.error.message);
  leadId = (Array.isArray(created.data) ? created.data[0] : created.data).id;

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  // Filters, against the real list.
  await page.goto(`${base}/leads`, { waitUntil: "networkidle" });
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  for (const label of ["ICP tier", "Region", "Lead list"]) await page.getByLabel(label).waitFor();
  await page.getByLabel("Lead list").selectOption("No phone");
  await page.getByLabel("ICP tier").selectOption("A - Core (design/renovation)");
  await page.getByRole("button", { name: "Filter" }).click();
  await page.waitForURL(/leadList=No\+phone/);
  const { count } = await db.from("lead").select("id", { count: "exact", head: true }).is("deletedAt", null).eq("leadList", "No phone").eq("icpTier", "A - Core (design/renovation)").neq("status", "PROSPECT");
  const rows = await page.locator("tbody tr").count();
  assert.equal(rows, Math.min(count, 500), `The filtered list shows the ${count} matching leads`);
  pass(`ICP tier, region and lead list filters narrow the list (${rows} Core leads with no phone)`);

  await page.goto(`${base}/leads?search=${encodeURIComponent(phone.slice(-9))}`, { waitUntil: "networkidle" });
  await page.getByText(`QA Reno ${run}`).first().waitFor();
  pass("Search finds a lead by phone number");

  // The lead page and the form.
  await page.goto(`${base}/leads/${leadId}`, { waitUntil: "networkidle" });
  await page.getByText("Prospecting", { exact: true }).waitFor();
  await page.getByText("4.6 ★ from 23 reviews").waitFor();
  await page.getByRole("link", { name: "Open listing" }).waitFor();
  pass("The lead page shows the Prospecting card");

  await page.goto(`${base}/leads/${leadId}/edit`, { waitUntil: "networkidle" });
  assert.equal(await page.locator('input[name="icpTier"]').inputValue(), "A - Core (design/renovation)");
  await page.locator('input[name="phoneType"]').fill("Mobile");
  await page.locator('input[name="googleReviewCount"]').fill("24");
  await page.locator('button[type="submit"]').last().click();
  let saved = null;
  for (let i = 0; i < 40 && saved?.phoneType !== "Mobile"; i++) {
    await page.waitForTimeout(500);
    saved = (await db.from("lead").select("phoneType, googleReviewCount, icpTier").eq("id", leadId).single()).data;
  }
  assert.equal(saved.phoneType, "Mobile");
  assert.equal(saved.googleReviewCount, 24);
  assert.equal(saved.icpTier, "A - Core (design/renovation)");
  pass("The edit form shows and saves the prospecting fields");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (leadId) {
    await db.from("audit_history").delete().eq("entityId", leadId);
    await db.from("lead").delete().eq("id", leadId);
  }
  if (userId) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", userId);
    await db.from("audit_history").delete().eq("changedById", userId);
    await db.from("app_user").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log("Temporary data removed.");
}
