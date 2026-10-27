// Booking a meeting and adding it to a calendar - in a real browser.
//
// Quick log's Meeting booked asks for the time; logging creates a meeting
// task on that day with its time; "Add to Google Calendar" opens the event
// filled in (checked by its link, in UTC), the .ics download has the same
// times, and the Tasks page offers the same. The browser runs in Pakistan
// time. Everything is temporary and removed afterwards.
//
// Usage: node scripts/test-prospect-meeting-browser.mjs http://localhost:3100
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

config({ path: ".env", quiet: true });
const base = process.argv[2] || "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("This check only targets the local application.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const run = randomUUID().slice(0, 6).toUpperCase();
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
const ids = { user: null, dataset: null, campaign: null };
let browser;

// Two days ahead at 15:30 Pakistan time (10:30 UTC), so it is always upcoming.
const day = new Date(Date.now() + 2 * 86_400_000);
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(day);
const startUtc = `${ymd.replace(/-/g, "")}T103000Z`;
const endUtc = `${ymd.replace(/-/g, "")}T111500Z`;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `meeting-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  ids.user = auth.data.user.id;
  await db.from("app_user").insert({ id: ids.user, fullName: `QA meeting ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });
  ids.dataset = (await db.from("prospect_dataset").insert({ name: `QA meeting ${run}` }).select("id").single()).data.id;
  ids.campaign = (await db.from("prospect_campaign").insert({ name: `QA Meeting Campaign ${run}`, ownerUserId: ids.user }).select("id").single()).data.id;
  const p = (await db.from("prospect").insert({ businessName: `QA Smile Dental ${run}`, datasetId: ids.dataset, city: "Toronto" }).select("id").single()).data;
  await db.from("prospect_phone").insert({ prospectId: p.id, phone: "+1 416 555 0100", isPrimary: true });
  await db.from("prospect_person").insert({ prospectId: p.id, name: "Jane Smith", role: "Owner", isPrimary: true });
  await db.from("prospect_campaign_entry").insert({ campaignId: ids.campaign, prospectId: p.id, status: "replied" });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, timezoneId: "Asia/Karachi", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/prospects/${p.id}?campaign=${ids.campaign}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Meeting booked" }).click();
  await page.getByLabel("Meeting date and time").fill(`${ymd}T15:30`);
  await page.getByLabel("Meeting length").selectOption("45");
  await page.getByRole("button", { name: "Log the meeting" }).click();
  await page.getByText("Meeting booked logged.").waitFor({ timeout: 30000 });
  const task = (await db.from("prospect_task").select("title, \"dueDate\", \"meetingAt\", \"durationMinutes\"").eq("prospectId", p.id).single()).data;
  assert.equal(task.title, `Meeting with QA Smile Dental ${run}`);
  assert.equal(task.dueDate, ymd);
  assert.equal(new Date(task.meetingAt).toISOString(), `${ymd}T10:30:00.000Z`);
  assert.equal(task.durationMinutes, 45);
  pass("Meeting booked asks for the time and creates the meeting task on that day, at 3:30 pm Pakistan time");

  const href = await page.getByRole("link", { name: "Add to Google Calendar" }).first().getAttribute("href");
  const url = new URL(href);
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("dates"), `${startUtc}/${endUtc}`);
  assert.equal(url.searchParams.get("text"), `Meeting with QA Smile Dental ${run}`);
  assert.match(url.searchParams.get("details"), /With Jane Smith, Owner/);
  assert.match(url.searchParams.get("details"), /Phone: \+1 416 555 0100/);
  assert.match(url.searchParams.get("details"), /\/prospects\//);
  pass("Add to Google Calendar opens the event with the right time, the contact and a link back");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ".ics" }).first().click()]);
  const ics = readFileSync(await download.path(), "utf8");
  assert.ok(ics.includes(`DTSTART:${startUtc}`) && ics.includes(`DTEND:${endUtc}`));
  pass("The .ics download has the same start and end");

  await page.goto(`${base}/prospects/tasks?tab=upcoming`, { waitUntil: "networkidle" });
  await page.getByText(`Meeting with QA Smile Dental ${run}`).waitFor();
  const tasksHref = await page.getByRole("link", { name: "Add to Google Calendar" }).first().getAttribute("href");
  assert.equal(new URL(tasksHref).searchParams.get("dates"), `${startUtc}/${endUtc}`);
  pass("The Tasks page shows the meeting with its own Add to calendar");

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
  if (ids.user) {
    await db.from("prospect_task").delete().eq("createdById", ids.user);
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", ids.user);
    await db.from("audit_history").delete().eq("changedById", ids.user);
    await db.from("app_user").delete().eq("id", ids.user);
    await db.auth.admin.deleteUser(ids.user).catch(() => {});
  }
  console.log("Temporary data removed.");
}
