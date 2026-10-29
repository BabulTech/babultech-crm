// The Company overview - in a real browser.
//
// A CRM Admin opens it: the sections are there and the figures match the
// database's company_overview() for the same period; the period buttons
// change the period; and someone without administrator access is refused.
// Only two temporary logins are created, and both are removed.
//
// Usage: node scripts/test-company-overview-browser.mjs http://localhost:3100
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
const ids = { users: [], role: randomUUID() };
let browser;
const fmt = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

async function makeUser(name, roleId) {
  const email = `overview-${name}-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  await db.from("app_user").insert({ id: auth.data.user.id, fullName: `QA ${name} ${run}`, email, roleId, status: "ACTIVE", updatedAt: new Date().toISOString() });
  ids.users.push(auth.data.user.id);
  return { email, password };
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

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  await db.from("security_role").insert({ id: ids.role, name: `QA Plain ${run}`, permissions: ["lead:read"], dataScope: "OWN", updatedAt: new Date().toISOString() });
  const admin = await makeUser("admin", crm.id);
  const plain = await makeUser("plain", ids.role);

  // This month, in Pakistan time, as the page works it out.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const from = `${today.slice(0, 8)}01`;
  const { data: expected, error } = await db.rpc("company_overview", { p_from: from, p_to: today });
  if (error) throw new Error(error.message);

  browser = await chromium.launch({ headless: true });
  const page = await signIn(admin);
  await page.goto(`${base}/overview`, { waitUntil: "networkidle" });
  for (const heading of ["Needs your decision", "From prospect to payment", "Sales", "Money", "Delivery", "Team in this period", "This week's workload"]) {
    await page.getByText(heading, { exact: true }).first().waitFor();
  }
  pass("The overview shows decisions, headline figures, funnel, sales, money, delivery, team and workload");

  // The page's words in lower case (tile labels are shown in capitals), one space between each.
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").toLowerCase();
  assert.ok(text.includes(`hours logged ${fmt(expected.current.hoursLogged)}`), "Hours logged matches the database");
  assert.ok(text.includes(`prospects added ${fmt(expected.funnel.prospectsAdded)}`), "Funnel matches the database");
  assert.ok(text.includes(`${expected.delivery.activeProjects} active projects`), "Active projects match");
  assert.ok(text.includes(`approvals waiting ${fmt(expected.attention.approvals)}`), "Approvals match");
  pass(`The figures match the database (${fmt(expected.current.hoursLogged)} hours, ${fmt(expected.funnel.prospectsAdded)} prospects added, ${expected.delivery.activeProjects} projects)`);

  await page.getByRole("link", { name: "Last week", exact: true }).click();
  await page.waitForURL(/range=last-week/);
  await page.getByText(/compared with/).waitFor();
  assert.notEqual((await page.locator("body").innerText()).includes(`from ${from}`), true);
  pass("The period buttons change the period");

  const other = await signIn(plain);
  await other.goto(`${base}/overview`, { waitUntil: "networkidle" });
  assert.equal(await other.getByText("Needs your decision", { exact: true }).count(), 0, "Not shown to a plain user");
  pass("Someone without administrator access cannot see it");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of ids.users) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", id);
    await db.from("audit_history").delete().eq("changedById", id);
    await db.from("app_user").delete().eq("id", id);
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  await db.from("security_role").delete().eq("id", ids.role);
  console.log("Temporary data removed.");
}
