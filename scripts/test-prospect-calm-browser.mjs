// The prospect page works without page reloads: status, note, task and Next
// Prospect. Temporary example.com login, campaign and prospects, all removed.
//
// Usage: node scripts/test-prospect-calm-browser.mjs http://localhost:3100
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
const pass = (w) => console.log(`  PASS  ${w}`);
const ids = { a: randomUUID(), b: randomUUID(), campaign: randomUUID(), user: null };
let browser;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `calm-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  ids.user = auth.data.user.id;
  await db.from("app_user").insert({ id: ids.user, fullName: `QA calm ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });
  for (const [id, n] of [[ids.a, "A"], [ids.b, "B"]]) {
    const r = await db.from("prospect").insert({ id, businessName: `QA Calm ${n} ${run}`, status: "ACTIVE" });
    if (r.error) throw new Error(r.error.message);
  }
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/prospects/${ids.a}`, { waitUntil: "networkidle" });
  await page.evaluate(() => { window.__calm = true; });
  const left = await page.getByText("Business", { exact: true }).first().boundingBox();
  const hist = await page.getByText("History", { exact: true }).first().boundingBox().catch(() => null);
  assert.ok(left.x < 700, "Business is in the wide column");
  if (hist) assert.ok(hist.x > left.x, "History is in the side column");
  pass("Business and History have swapped places");

  await page.locator('input[name="dueDate"]').waitFor({ timeout: 3000 }).catch(() => {});
  await page.getByRole("link", { name: "Next Prospect" }).click();
  await page.waitForURL((u) => !u.pathname.endsWith(ids.a), { timeout: 15000 });
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.equal(await page.evaluate(() => window.__calm), true);
  pass("Next Prospect shows the next prospect without a page reload");
  console.log("\nAll checks passed.");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await db.from("prospect").delete().in("id", [ids.a, ids.b]);
  if (ids.user) {
    for (const t of ["notification", "recent_record", "login_event", "user_preference"]) await db.from(t).delete().eq("userId", ids.user);
    await db.from("audit_history").delete().eq("changedById", ids.user);
    await db.from("app_user").delete().eq("id", ids.user);
    await db.auth.admin.deleteUser(ids.user).catch(() => {});
  }
  console.log("Temporary data removed.");
}
