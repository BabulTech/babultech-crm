// Weekly timesheets - in a real browser.
//
// An employee with 10 of 40 hours logged last week must give a reason to
// submit; a CRM Admin returns it with remarks, the employee resubmits, and the
// CRM Admin approves. The CRM Admin's own week can only be approved by a Super
// Admin. Team timesheets shows committed and logged hours. All logins are
// temporary example.com ones and are removed, with everything they made.
//
// Usage: node scripts/test-weekly-timesheets-browser.mjs http://localhost:3100
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
const ids = { users: [], role: randomUUID(), project: randomUUID() };
const now = () => new Date().toISOString();
let browser;

// Last week's Monday, Pakistan time.
const todayPk = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const t = new Date(`${todayPk}T00:00:00Z`);
t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) - 7);
const week = t.toISOString().slice(0, 10);
const dayOf = (n) => { const d = new Date(`${week}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function makeUser(name, roleId) {
  const email = `wts-${name}-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  await db.from("app_user").insert({ id: auth.data.user.id, fullName: `QA ${name} ${run}`, email, roleId, status: "ACTIVE", updatedAt: now() });
  ids.users.push(auth.data.user.id);
  return { email, password, id: auth.data.user.id, name: `QA ${name} ${run}` };
}

async function signIn(user) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });
  return page;
}

const sheetOf = async (userId) => (await db.from("weekly_timesheet").select("*").eq("userId", userId).eq("weekStart", week).maybeSingle()).data;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const superRole = (await db.from("security_role").select("id").contains("permissions", ["*"]).limit(1).single()).data;
  await db.from("security_role").insert({ id: ids.role, name: `QA Staff ${run}`, permissions: ["project:read"], dataScope: "OWN", updatedAt: now() });
  const emp = await makeUser("staff", ids.role);
  const admin = await makeUser("crmadmin", crm.id);
  const boss = await makeUser("super", superRole.id);
  await db.from("project").insert({ id: ids.project, projectNumber: `QA-WTS-${run}`, name: `QA Timesheets ${run}`, projectManagerId: admin.id, projectType: "INTERNAL", billingType: "FIXED", status: "ACTIVE", updatedAt: now() });
  await db.from("project_member").insert({ projectId: ids.project, userId: emp.id, active: true, projectRole: "Developer", updatedAt: now() });
  const tl = await db.from("time_log").insert([0, 1].map((n) => ({ id: randomUUID(), userId: emp.id, projectId: ids.project, workDate: dayOf(n), hours: 5, description: `QA work ${n}`, billable: false, approvalStatus: "DRAFT", updatedAt: now() })));
  if (tl.error) throw new Error(tl.error.message);

  browser = await chromium.launch({ headless: true });
  const e = await signIn(emp);
  await e.goto(`${base}/timesheets?week=${week}`, { waitUntil: "networkidle" });
  const panel = e.getByTestId("week-commitment");
  await panel.getByText("10 of 40 hours").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Submit week" }).isDisabled(), true);
  pass("The employee sees 10 of 40 committed hours, and a short week cannot be submitted without a reason");

  await panel.getByLabel("Why the week is short").fill("No work assigned after Tuesday");
  await panel.getByRole("button", { name: "Submit week" }).click();
  await panel.getByText("Submitted, waiting for approval").waitFor();
  let s = await sheetOf(emp.id);
  assert.equal(s.status, "SUBMITTED");
  assert.equal(s.shortfallReason, "No work assigned after Tuesday");
  const notes = (await db.from("notification").select("userId").eq("entityId", s.id).eq("kind", "APPROVAL_REQUESTED")).data;
  assert.ok(notes.some((n) => n.userId === admin.id) && notes.some((n) => n.userId === boss.id), "CRM Admin and Super Admin are asked");
  pass("Submitted with the reason; the CRM Admin and Super Admin are notified");

  const a = await signIn(admin);
  await a.goto(`${base}/timesheets/approvals?week=${week}`, { waitUntil: "networkidle" });
  let row = a.locator(`tr[data-person="${emp.name}"]`);
  await row.getByText("Submitted").waitFor();
  await row.getByRole("button", { name: "Review" }).click();
  await a.getByText("No work assigned after Tuesday").waitFor();
  await a.getByText("QA work 0").waitFor();
  await a.getByLabel(`Remarks for ${emp.name}`).fill("Time is not complete");
  await a.getByRole("button", { name: "Return with remarks" }).click();
  await a.locator(`tr[data-person="${emp.name}"]`).getByText("Returned").waitFor();
  s = await sheetOf(emp.id);
  assert.equal(s.status, "RETURNED");
  assert.equal(s.remarks, "Time is not complete");
  assert.ok((await db.from("notification").select("id").eq("userId", emp.id).eq("kind", "APPROVAL_DECIDED")).data.length >= 1);
  pass("The CRM Admin reviews the entries and returns the week with \"Time is not complete\"; the employee is told");

  await e.goto(`${base}/timesheets?week=${week}`, { waitUntil: "networkidle" });
  await panel.getByText("Time is not complete").waitFor();
  await panel.getByLabel("Why the week is short").fill("No work assigned after Tuesday, confirmed with my lead");
  await panel.getByRole("button", { name: "Submit the week again" }).click();
  await panel.getByText("Submitted, waiting for approval").waitFor();
  await a.goto(`${base}/timesheets/approvals?week=${week}&show=waiting`, { waitUntil: "networkidle" });
  row = a.locator(`tr[data-person="${emp.name}"]`);
  await row.getByRole("button", { name: "Review" }).click();
  await a.getByRole("button", { name: "Approve" }).click();
  await a.locator(`tr[data-person="${emp.name}"]`).getByText("Approved").first().waitFor().catch(() => {});
  s = await sheetOf(emp.id);
  assert.equal(s.status, "APPROVED");
  const logs = (await db.from("time_log").select("approvalStatus").eq("userId", emp.id)).data;
  assert.ok(logs.every((l) => l.approvalStatus === "APPROVED"));
  pass("The employee sees the remarks, resubmits, and the CRM Admin approves; the entries are approved too");

  // The CRM Admin's own week: only a Super Admin may approve it.
  await a.goto(`${base}/timesheets?week=${week}`, { waitUntil: "networkidle" });
  await a.getByTestId("week-commitment").getByLabel("Why the week is short").fill("Admin work, not logged");
  await a.getByTestId("week-commitment").getByRole("button", { name: "Submit week" }).click();
  await a.getByTestId("week-commitment").getByText("Submitted, waiting for approval").waitFor();
  const adminSheet = await sheetOf(admin.id);
  const toAdmins = (await db.from("notification").select("userId").eq("entityId", adminSheet.id).eq("kind", "APPROVAL_REQUESTED")).data;
  assert.deepEqual(toAdmins.map((n) => n.userId), [boss.id]);
  await a.goto(`${base}/timesheets/approvals?week=${week}`, { waitUntil: "networkidle" });
  assert.equal(await a.locator(`tr[data-person="${admin.name}"]`).getByRole("button", { name: "Review" }).count(), 0);
  const b = await signIn(boss);
  await b.goto(`${base}/timesheets/approvals?week=${week}`, { waitUntil: "networkidle" });
  assert.equal(await b.locator(`tr[data-person="${boss.name}"]`).count(), 0, "Super Admins keep no timesheet");
  await b.locator(`tr[data-person="${admin.name}"]`).getByRole("button", { name: "Review" }).click();
  await b.getByRole("button", { name: "Approve" }).click();
  await b.locator(`tr[data-person="${admin.name}"]`).getByText("Approved").first().waitFor();
  pass("A CRM Admin's week goes to the Super Admin only, who approves it; Super Admins have no timesheet");

  const empRow = b.locator(`tr[data-person="${emp.name}"]`);
  await empRow.getByText("40").first().waitFor();
  assert.ok((await empRow.innerText()).includes("10"));
  await b.goto(`${base}/`, { waitUntil: "networkidle" });
  await b.getByText("Waiting for you:").waitFor();
  pass("Team timesheets shows committed and logged hours, and the dashboard shows the timesheet summary");

  assert.deepEqual(errors, []);
  console.log(`\nAll ${passed.length} checks passed.`);
} catch (err) {
  console.error("FAILED:", err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  const logIds = ((await db.from("time_log").select("id").eq("projectId", ids.project)).data ?? []).map((l) => l.id);
  if (logIds.length) await db.from("audit_history").delete().in("entityId", logIds);
  await db.from("time_log").delete().eq("projectId", ids.project);
  await db.from("project_member").delete().eq("projectId", ids.project);
  await db.from("weekly_timesheet").delete().in("userId", ids.users.length ? ids.users : [randomUUID()]);
  await db.from("audit_history").delete().eq("entityId", ids.project);
  await db.from("project").delete().eq("id", ids.project);
  for (const id of ids.users) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", id);
    await db.from("audit_history").delete().eq("changedById", id);
    await db.from("app_user").delete().eq("id", id);
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  await db.from("security_role").delete().eq("id", ids.role);
  console.log("Temporary data removed.");
}
