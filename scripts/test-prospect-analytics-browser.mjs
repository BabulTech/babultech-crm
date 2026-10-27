// Prospecting, phase 4 - outreach analytics and reminders.
//
// Logs a known set of outreach in a temporary campaign (4 emails, 1 reply,
// 5 calls of which 2 connected and 1 voicemail, 1 meeting) and checks the
// analytics page shows exactly that, filtered to the campaign. Then runs the
// daily reminder: one summary of follow-ups due for the person, one "no next
// step" alert for the campaign owner, and running it again the same day adds
// nothing. Everything is temporary and removed afterwards.
//
// Usage: node scripts/test-prospect-analytics-browser.mjs http://localhost:3100
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const base = process.argv[2] || "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("This check only targets the local application.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  return r.json();
};

const run = randomUUID().slice(0, 6).toUpperCase();
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
const ids = { user: null, dataset: null, campaign: null };
let browser;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `analytics-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  ids.user = auth.data.user.id;
  await db.from("app_user").insert({ id: ids.user, fullName: `QA analytics ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });

  ids.dataset = (await db.from("prospect_dataset").insert({ name: `QA analytics ${run}` }).select("id").single()).data.id;
  ids.campaign = (await db.from("prospect_campaign").insert({ name: `QA Analytics ${run}`, ownerUserId: ids.user }).select("id").single()).data.id;
  const ps = (await db.from("prospect").insert(["A", "B", "C"].map((n) => ({ businessName: `QA An ${run} ${n}`, datasetId: ids.dataset }))).select("id")).data;
  await db.from("prospect_campaign_entry").insert([
    { campaignId: ids.campaign, prospectId: ps[0].id, status: "replied" },
    { campaignId: ids.campaign, prospectId: ps[1].id, status: "contacted" },
    { campaignId: ids.campaign, prospectId: ps[2].id, status: "new" },
  ]);
  const at = (h) => { const d = new Date(); d.setUTCHours(h, 15, 0, 0); return d.toISOString(); }; // 10:15 Pakistan time at h=5
  const acts = [
    ["EMAIL_SENT", 0], ["EMAIL_SENT", 1], ["EMAIL_SENT", 2], ["FOLLOWUP_SENT", 0], ["EMAIL_REPLY", 0],
    ["CALL_ATTEMPTED", 1], ["CALL_ATTEMPTED", 2], ["VOICEMAIL", 2], ["CALL_CONNECTED", 0], ["CALL_CONNECTED", 1], ["MEETING_BOOKED", 0],
  ];
  await db.from("prospect_activity").insert(acts.map(([type, i]) => ({ prospectId: ps[i].id, campaignId: ids.campaign, type, actorId: ids.user, occurredAt: at(5) })));
  // An open follow-up due today on the first prospect; the second has none (no next step).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  await db.from("prospect_task").insert({ prospectId: ps[0].id, campaignId: ids.campaign, title: "QA follow up", type: "followup_email", dueDate: today, assignedTo: ids.user, createdById: ids.user });

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/prospects/analytics?days=7&campaignId=${ids.campaign}`, { waitUntil: "networkidle" });
  // The page's text with every run of whitespace as one space.
  const tiles = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  for (const re of [/Emails sent 4 /i, /Replies 1 25(\.0)?% reply rate/i, /Calls 5 2 connected · 1 voicemail/i, /Connect rate 40%/i, /Meetings booked 1 /i, /Prospects touched 3 /i]) assert.match(tiles, re);
  pass("The figures match what was logged: 4 emails, 25% reply rate, 5 calls, 40% connected, 1 meeting, 3 prospects touched");

  const funnel = tiles;
  assert.match(funnel, /In campaigns 3 /i);
  assert.match(funnel, /Worked 2(67)?%/i);
  assert.match(funnel, /Replied 1(50)?%/i);
  await page.getByText("Daily tracker").waitFor();
  await page.getByText("10:15 AM").first().waitFor();
  await page.getByRole("cell", { name: `QA analytics ${run}`, exact: true }).waitFor();
  pass("The funnel, the daily tracker with its outreach window, and the per-person table are right");

  // The daily reminder, twice.
  const before = (await db.from("notification").select("id", { count: "exact", head: true }).eq("userId", ids.user)).count ?? 0;
  await sql("select public.prospect_reminders();");
  await sql("select public.prospect_reminders();");
  const notes = (await db.from("notification").select("title, link").eq("userId", ids.user)).data;
  assert.equal(notes.length - before, 2, `Two reminders, not repeated: ${JSON.stringify(notes)}`);
  assert.ok(notes.some((n) => n.title === "1 outreach follow-up due today" && n.link === "/prospects/tasks"));
  assert.ok(notes.some((n) => n.title === `1 prospect with no next step in QA Analytics ${run}` && n.link === `/prospects/campaigns/${ids.campaign}`));
  pass("The daily reminder sends one follow-ups summary and one no-next-step alert, once a day");

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
