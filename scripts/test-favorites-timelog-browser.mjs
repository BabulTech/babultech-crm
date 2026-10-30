// Favourites and the shared time form - in a real browser, with one temporary
// example.com login and project, all removed afterwards.
//
// Usage: node scripts/test-favorites-timelog-browser.mjs http://localhost:3100
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
const now = () => new Date().toISOString();
const pass = (w) => console.log(`  PASS  ${w}`);
const ids = { project: randomUUID(), task: randomUUID(), user: null };
const errors = [];
let browser;

async function fillAndSave(page, text) {
  const form = page.getByTestId("time-entry-form");
  for (const f of ["Date", "Started", "Ended", "Hours"]) await form.getByLabel(f, { exact: true }).waitFor();
  if (await form.getByLabel("Project").isEnabled()) await form.getByLabel("Project").selectOption(ids.project);
  await form.getByLabel("Task").selectOption(ids.task);
  await form.getByLabel("Hours").fill("2");
  await form.locator('[contenteditable="true"]').click();
  await page.keyboard.type(text);
  await form.getByRole("button", { name: "Bold" }).click().catch(() => {});
  await form.getByRole("button", { name: "Log time" }).click();
}

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `fav-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  ids.user = auth.data.user.id;
  await db.from("app_user").insert({ id: ids.user, fullName: `QA fav ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: now() });
  await db.from("project").insert({ id: ids.project, projectNumber: `QA-FAV-${run}`, name: `QA Fav ${run}`, projectManagerId: ids.user, projectType: "INTERNAL", billingType: "FIXED", status: "ACTIVE", updatedAt: now() });
  await db.from("project_member").insert({ projectId: ids.project, userId: ids.user, active: true, projectRole: "Developer", updatedAt: now() });
  const t = await db.from("project_task").insert({ id: ids.task, projectId: ids.project, name: `QA Task ${run}`, updatedAt: now() });
  if (t.error) throw new Error(t.error.message);

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/leads?status=NEW`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add this screen to favourites" }).click();
  await page.getByTestId("sidebar-favorites").getByText("Leads").waitFor();
  const link = (await db.from("favorite_link").select("href").eq("userId", ids.user)).data;
  assert.deepEqual(link.map((l) => l.href), ["/leads?status=NEW"]);
  pass("A screen is starred with its filters and appears in the sidebar");

  await page.getByRole("button", { name: "Favourites", exact: true }).first().click();
  const menu = page.getByRole("dialog", { name: "Favourites" }).first();
  await menu.getByRole("button", { name: "Log time" }).click();
  await page.getByTestId("sidebar-favorites").getByText("Log time").waitFor();
  await menu.getByRole("button", { name: "Move Log time up" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar-favorites"] li')?.textContent.includes("Log time"));
  await menu.getByRole("button", { name: "Rename Leads" }).click();
  await menu.getByLabel("Favourite name").fill("New leads");
  await menu.getByRole("button", { name: "Save name" }).click();
  await page.getByTestId("sidebar-favorites").getByText("New leads").waitFor();
  pass("An action is added, moved up, and a favourite renamed");

  await menu.getByRole("link", { name: "Log time" }).click();
  await page.waitForURL(/log=1/);
  await fillAndSave(page, `From timesheet ${run}`);
  await page.getByTestId("time-entry-form").waitFor({ state: "detached", timeout: 30000 });
  await page.getByText(`From timesheet ${run}`).waitFor();
  pass("The Log time shortcut opens the shared form and saves from Timesheets");

  await page.goto(`${base}/projects/${ids.project}?tab=activity`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: /Work log/ }).click().catch(() => {});
  await page.getByRole("button", { name: "Log work" }).click();
  await fillAndSave(page, `From project ${run}`);
  let after = [];
  for (let i = 0; i < 20 && after.length < 2; i++) {
    await page.waitForTimeout(1000);
    after = (await db.from("time_log").select("description").eq("userId", ids.user)).data;
  }
  if (after.length < 2) throw new Error(`Not saved. Form says: ${await page.getByTestId("time-entry-form").innerText().catch(() => "no form")}`);
  assert.ok(after.some((r) => r.description.includes(`From project ${run}`)));
  pass("A project's Work log has the same fields and saves the same way");

  assert.deepEqual(errors, []);
  console.log("\nAll checks passed.");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  const logIds = ((await db.from("time_log").select("id").eq("projectId", ids.project)).data ?? []).map((l) => l.id);
  if (logIds.length) await db.from("audit_history").delete().in("entityId", logIds);
  await db.from("time_log").delete().eq("projectId", ids.project);
  await db.from("project_task").delete().eq("id", ids.task);
  await db.from("project_member").delete().eq("projectId", ids.project);
  await db.from("audit_history").delete().eq("entityId", ids.project);
  await db.from("project").delete().eq("id", ids.project);
  if (ids.user) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", ids.user);
    await db.from("audit_history").delete().eq("changedById", ids.user);
    await db.from("app_user").delete().eq("id", ids.user);
    await db.auth.admin.deleteUser(ids.user).catch(() => {});
  }
  console.log("Temporary data removed.");
}
