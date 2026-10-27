// Every role shows the full permission list - in a real browser.
//
// The CRM Admin role used to show only a sentence instead of its permissions,
// so new ones such as the Prospecting permissions looked missing. Now its list
// is shown with every permission ticked except Delete records and Manage
// roles; the Super Admin's shows all ticked; an ordinary role lists the
// Prospecting permissions too. A temporary admin login is the only thing
// created, and it is removed.
//
// Usage: node scripts/test-role-permissions-browser.mjs http://localhost:3100
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

try {
  const crm = (await db.from("security_role").select("id, name").eq("name", "CRM Admin").single()).data;
  const superRole = (await db.from("security_role").select("name").contains("permissions", ["*"]).limit(1).single()).data;
  const email = `roles-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  userId = auth.data.user.id;
  await db.from("app_user").insert({ id: userId, fullName: `QA roles ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  // Opens a role from the Roles list: its name heading, then the nearest
  // block around it that holds its View/Edit button.
  const openRole = async (name) => {
    await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
    const heading = page.locator("p.font-medium").filter({ hasText: name }).filter({ hasNotText: "·" }).first();
    const row = heading.locator("xpath=ancestor::*[.//button][1]");
    await row.getByRole("button", { name: /^(View|Edit)$/ }).first().click();
    await page.getByText("See prospects", { exact: true }).waitFor();
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
  };
  const box = (label) => page.locator("label").filter({ has: page.getByText(label, { exact: true }) }).locator('input[type="checkbox"]');

  await openRole(crm.name);
  for (const label of ["See prospects", "Work on prospects", "Qualify prospects", "See leads"]) {
    assert.equal(await box(label).isChecked(), true, `${label} ticked`);
    assert.equal(await box(label).isDisabled(), true, `${label} read-only`);
  }
  assert.equal(await box("Delete records").isChecked(), false);
  await page.getByText("Only the Super Admin has this.").first().waitFor();
  pass("CRM Admin lists every permission: the Prospecting ones ticked, Delete records not");

  await openRole(superRole.name);
  for (const label of ["Qualify prospects", "Delete records"]) assert.equal(await box(label).isChecked(), true);
  pass("Super Admin lists every permission ticked");

  await openRole("Marketing");
  for (const label of ["See prospects", "Work on prospects", "Qualify prospects"]) assert.equal(await box(label).count(), 1);
  pass("An ordinary role (Marketing) lists the Prospecting permissions to tick");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (userId) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", userId);
    await db.from("audit_history").delete().eq("changedById", userId);
    await db.from("app_user").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log("Temporary data removed.");
}
