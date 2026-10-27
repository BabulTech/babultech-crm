// Prospecting, phase 2 - outreach campaigns in a real browser.
//
// Creates a campaign, adds every prospect of a temporary dataset with "Add all
// matching", starts calling, and logs a call: the touch is counted, the
// follow-up task is created, the suggested status is applied with one click,
// and the task appears on the Tasks page and can be ticked off. Then the
// campaign gets a team, and a prospecting user who is not on it can no longer
// see it. Everything is temporary and removed afterwards.
//
// Usage: node scripts/test-prospect-outreach-browser.mjs http://localhost:3100
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
const ids = { users: [], role: randomUUID(), dataset: null, campaign: null };
let browser;

async function makeUser(name, roleId) {
  const email = `outreach-${name}-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  const { error } = await db.from("app_user").insert({ id: auth.data.user.id, fullName: `QA ${name} ${run}`, email, roleId, status: "ACTIVE", updatedAt: new Date().toISOString() });
  if (error) throw new Error(error.message);
  ids.users.push(auth.data.user.id);
  return { id: auth.data.user.id, email, password };
}

async function signIn(context, user) {
  const page = await context.newPage();
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
  await db.from("security_role").insert({ id: ids.role, name: `QA Prospector ${run}`, permissions: ["prospect:read", "prospect:write"], dataScope: "OWN", updatedAt: new Date().toISOString() });
  const admin = await makeUser("admin", crm.id);
  const worker = await makeUser("worker", ids.role);

  const ds = await db.from("prospect_dataset").insert({ name: `QA outreach ${run}` }).select("id").single();
  ids.dataset = ds.data.id;
  const names = ["Alpha", "Bravo", "Charlie"].map((n) => `QA Outreach ${run} ${n}`);
  const created = await db.from("prospect").insert(names.map((businessName, i) => ({ businessName, datasetId: ids.dataset, createdAt: new Date(Date.now() - (3 - i) * 1000).toISOString() }))).select("id, businessName");
  if (created.error) throw new Error(created.error.message);
  const prospects = created.data;
  await db.from("prospect_phone").insert(prospects.map((p, i) => ({ prospectId: p.id, phone: `+1 416 555 01${i}${run.slice(0, 1).replace(/\D/, "7")}`, isPrimary: true })));

  browser = await chromium.launch({ headless: true });
  const page = await signIn(await browser.newContext({ viewport: { width: 1400, height: 1000 } }), admin);

  // Create a campaign.
  await page.goto(`${base}/prospects/campaigns`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.locator('input[name="name"]').fill(`QA Campaign ${run}`);
  await page.getByRole("button", { name: "Create campaign" }).click();
  await page.waitForURL(/\/prospects\/campaigns\/[0-9a-f-]{36}/, { timeout: 30000 });
  ids.campaign = page.url().split("/").pop().split("?")[0];
  pass("A campaign is created and opens");

  // Add all matching prospects from the list.
  await page.getByRole("link", { name: "Add prospects" }).click();
  await page.waitForURL(/addTo=/);
  await page.goto(`${base}/prospects?addTo=${ids.campaign}&datasetId=${ids.dataset}`, { waitUntil: "networkidle" });
  assert.equal(await page.getByLabel("Campaign to add to").inputValue(), ids.campaign);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Add all 3 matching" }).click();
  await page.getByText(`Added 3 to QA Campaign ${run}.`).waitFor({ timeout: 30000 });
  pass("Add all matching puts every prospect of the filtered list into the campaign");

  // Start calling and log a call.
  await page.goto(`${base}/prospects/campaigns/${ids.campaign}`, { waitUntil: "networkidle" });
  await page.getByText("3 of 3").or(page.getByText("1–3 of 3")).first().waitFor();
  await page.getByRole("link", { name: /Start calling:/ }).click();
  await page.waitForURL(/\/prospects\/[0-9a-f-]{36}\?campaign=/);
  const prospectId = page.url().split("/prospects/")[1].split("?")[0];
  await page.getByLabel("Note", { exact: true }).fill("Receptionist said call after 3pm");
  await page.getByRole("button", { name: "Call, no answer" }).click();
  await page.getByText("Call, no answer logged.").waitFor({ timeout: 30000 });
  await page.getByText(/Follow-up task: Try calling again/).waitFor();
  await page.getByRole("link", { name: /Next: QA Outreach/ }).waitFor();
  await page.getByRole("button", { name: "Move to Contacted" }).click();
  await page.waitForLoadState("networkidle");
  let entry = null;
  for (let i = 0; i < 40 && entry?.status !== "contacted"; i++) {
    await page.waitForTimeout(500);
    entry = (await db.from("prospect_campaign_entry").select("status, \"touchCount\", \"lastContactedAt\"").eq("campaignId", ids.campaign).eq("prospectId", prospectId).single()).data;
  }
  assert.equal(entry.status, "contacted");
  assert.equal(entry.touchCount, 1);
  assert.ok(entry.lastContactedAt);
  const acts = (await db.from("prospect_activity").select("type, content").eq("prospectId", prospectId)).data;
  assert.ok(acts.some((a) => a.type === "CALL_ATTEMPTED" && a.content === "Receptionist said call after 3pm"));
  assert.ok(acts.some((a) => a.type === "STATUS_CHANGED"));
  pass("Quick log records the call with its note, counts the touch, and Move to Contacted applies the suggestion");

  await page.getByText("Receptionist said call after 3pm").waitFor();
  const task = (await db.from("prospect_task").select("id, title, \"dueDate\", status").eq("prospectId", prospectId).single()).data;
  assert.equal(task.title, "Try calling again");
  pass("The follow-up task is created and the history shows the call");

  await page.goto(`${base}/prospects/tasks?tab=upcoming`, { waitUntil: "networkidle" });
  const box = page.getByLabel("Done: Try calling again").first();
  await box.waitFor();
  await box.click();
  let done = null;
  for (let i = 0; i < 40 && done !== "done"; i++) { await page.waitForTimeout(500); done = (await db.from("prospect_task").select("status").eq("id", task.id).single()).data.status; }
  assert.equal(done, "done");
  pass("The task is on the Tasks page and can be ticked off");

  // A team narrows who can work the campaign.
  const workerPage = await signIn(await browser.newContext({ viewport: { width: 1400, height: 1000 } }), worker);
  await workerPage.goto(`${base}/prospects/campaigns`, { waitUntil: "networkidle" });
  await workerPage.getByRole("link", { name: `QA Campaign ${run}` }).waitFor();
  await page.goto(`${base}/prospects/campaigns/${ids.campaign}`, { waitUntil: "networkidle" });
  await page.getByLabel("Add to team").selectOption(admin.id);
  await page.getByLabel("Their role").selectOption("manager");
  await page.getByRole("button", { name: "Add to team" }).click();
  await page.getByLabel(`Role of QA admin ${run}`).waitFor({ timeout: 20000 });
  await workerPage.goto(`${base}/prospects/campaigns`, { waitUntil: "networkidle" });
  assert.equal(await workerPage.getByRole("link", { name: `QA Campaign ${run}` }).count(), 0, "Hidden from someone not on the team");
  const blocked = await workerPage.goto(`${base}/prospects/campaigns/${ids.campaign}`, { waitUntil: "networkidle" });
  assert.ok(blocked.status() === 404 || await workerPage.getByText(/not found|could not be found/i).count() > 0);
  pass("Once a campaign has a team, someone not on it no longer sees it");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (ids.campaign) await db.from("prospect_campaign").delete().eq("id", ids.campaign);
  if (ids.dataset) {
    await db.from("prospect").delete().eq("datasetId", ids.dataset);
    await db.from("prospect_dataset").delete().eq("id", ids.dataset);
  }
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
