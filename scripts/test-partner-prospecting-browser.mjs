// A partner working prospects through the portal, in a real browser, plus the
// database boundary checked as each partner login.
//
// A partner's portal admin sees every prospect given to the partnership; their
// other logins see only their own; nobody at the partner sees ours. Qualifying
// one makes it the partner's registered lead. Nothing is emailed. Everything
// created is removed afterwards (the activity log keeps its entries: it cannot
// be changed, by design).
//
// Usage: node scripts/test-partner-prospecting-browser.mjs http://localhost:3100
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const base = process.argv[2] || "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("This check only targets the local application.");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 6).toUpperCase();
const tag = run.toLowerCase();
const now = () => new Date().toISOString();
const pass = (what) => console.log(`  PASS  ${what}`);
async function must(result, what) {
  const r = await result;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

const ids = {
  account: randomUUID(), partner: randomUUID(), person: randomUUID(), admin: null, user: null,
  given: randomUUID(), theirs: randomUUID(), ours: randomUUID(), lead: null,
};
const logins = {};
let browser;

async function signedIn(email, password) {
  const c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign in ${email}: ${error.message}`);
  return c;
}

try {
  console.log("\n00  A partner with two logins, and three prospects");
  const staff = await must(db.from("app_user").select("id").eq("userType", "INTERNAL").is("deletedAt", null).is("partnerId", null).limit(1).single(), "Find staff");
  await must(db.from("account").insert({ id: ids.account, accountNumber: `QPP-${run}`, name: `QA Prospecting ${run}`, accountType: "PARTNER", ownerUserId: staff.id, updatedAt: now() }), "Partner company");
  await must(db.from("contact").insert({ id: ids.person, accountId: ids.account, firstName: "Portal", lastName: `Person ${run}`, email: `qpp-${tag}@example.com`, updatedAt: now() }), "Partner person");
  await must(db.from("partner").insert({
    id: ids.partner, partnerNumber: `QPPP-${run}`, displayName: `QA Prospecting ${run}`, kind: "COMPANY", accountId: ids.account,
    partnerType: "ACCOUNT_MANAGEMENT", status: "ACTIVE", partnerManagerId: staff.id, defaultCommissionPercent: 10, email: `qpp-${tag}@example.com`, updatedAt: now(),
  }), "Partner");
  const role = await must(db.from("security_role").select("id").eq("name", "Partner").single(), "Partner role");
  for (const [key, portalRole] of [["admin", "ADMIN"], ["user", "USER"]]) {
    const email = `qpp-${key}-${tag}@example.com`;
    const password = randomBytes(24).toString("base64url");
    const a = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (a.error) throw new Error(a.error.message);
    ids[key] = a.data.user.id;
    logins[key] = { email, password };
    await must(db.from("app_user").insert({
      id: ids[key], fullName: `QA ${key} ${run}`, email, roleId: role.id, userType: "PARTNER", portalRole,
      partnerId: ids.partner, contactId: key === "admin" ? ids.person : null, status: "ACTIVE", updatedAt: now(),
    }), `Login ${key}`);
  }
  const prospect = (id, name, extra) => ({ id, businessName: name, nameNorm: name.toLowerCase().replace(/[^a-z0-9]/g, ""), status: "ACTIVE", updatedAt: now(), createdById: staff.id, ...extra });
  await must(db.from("prospect").insert([
    prospect(ids.given, `QA Given Traders ${run}`, { partnerId: ids.partner, ownerUserId: null }),
    prospect(ids.theirs, `QA User Owned ${run}`, { partnerId: ids.partner, ownerUserId: ids.user }),
    prospect(ids.ours, `QA Ours Only ${run}`, { ownerUserId: staff.id }),
  ]), "Prospects");
  await must(db.from("prospect_email").insert({ prospectId: ids.given, email: `qpp-given-${tag}@example.com`, emailNorm: `qpp-given-${tag}@example.com`, isPrimary: true }), "Prospect email");
  pass("Partner, two logins and three prospects ready");

  console.log("\n01  The database, as each partner login");
  const asAdmin = await signedIn(logins.admin.email, logins.admin.password);
  const asUser = await signedIn(logins.user.email, logins.user.password);
  const seen = async (c) => ((await c.from("prospect").select("id").in("id", [ids.given, ids.theirs, ids.ours])).data ?? []).map((r) => r.id).sort();
  assert.deepEqual(await seen(asAdmin), [ids.given, ids.theirs].sort(), "The portal admin sees both of the partner's prospects, not ours");
  pass("Portal admin sees the partner's two prospects and not ours");
  assert.deepEqual(await seen(asUser), [ids.theirs], "Another login sees only their own");
  pass("Another portal login sees only the one they own");
  const touched = await asAdmin.from("prospect").update({ notes: "x" }).eq("id", ids.ours).select("id");
  assert.equal((touched.data ?? []).length, 0, "Cannot change ours");
  pass("Cannot change one of our prospects");
  const stolen = await asAdmin.from("prospect").insert({ businessName: `QA Steal ${run}`, nameNorm: `qa steal ${tag}`, partnerId: randomUUID(), updatedAt: now() });
  assert.ok(stolen.error, "Cannot create a prospect for another partner");
  pass("Cannot create a prospect for another partner");
  const handed = await asAdmin.from("prospect").update({ ownerUserId: staff.id }).eq("id", ids.given).select("id");
  assert.ok(handed.error || !(handed.data ?? []).length, "Cannot hand a prospect to our staff");
  pass("Cannot hand a prospect to someone outside the partnership");

  console.log("\n02  The portal screens");
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(logins.admin.email);
  await page.locator('input[name="password"]').fill(logins.admin.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/prospects`, { waitUntil: "networkidle" });
  assert.ok(await page.getByText("Partner Portal").first().isVisible(), "Prospects opens inside the portal");
  assert.ok(await page.getByRole("link", { name: "Outreach campaigns" }).isVisible(), "Prospecting in the portal menu");
  if (!(await page.getByText(`QA Given Traders ${run}`).count())) console.log((await page.locator("main").innerText()).slice(0, 1500));
  assert.ok(await page.getByText(`QA Given Traders ${run}`).first().isVisible(), "Their prospect is listed");
  assert.equal(await page.getByText(`QA Ours Only ${run}`).count(), 0, "Ours is not listed");
  assert.equal(await page.getByText(/Email \d+ selected/).count(), 0, "No mass email");
  pass("Prospects opens in the portal with Prospecting in its menu, their prospects only");

  await page.goto(`${base}/prospects/${ids.ours}`, { waitUntil: "networkidle" });
  assert.equal(await page.getByText(`QA Ours Only ${run}`).count(), 0, "Ours does not open");
  pass("One of our prospects does not open");

  await page.goto(`${base}/leads`, { waitUntil: "networkidle" });
  assert.ok(new URL(page.url()).pathname.startsWith("/portal"), "Staff screens send them back to the portal");
  pass("Other staff screens still send them back to the portal");

  for (const path of ["/prospects/campaigns", "/prospects/tasks", "/prospects/analytics", "/prospects/datasets", "/prospects/import"]) {
    const res = await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    assert.ok(res && res.status() < 400, `${path} loads`);
    assert.equal(await page.getByText("Something went wrong").count(), 0, `${path} renders`);
  }
  pass("Campaigns, tasks, analytics, datasets and import all open");

  await page.goto(`${base}/prospects/${ids.given}`, { waitUntil: "networkidle" });
  assert.equal(await page.getByTestId("time-spent-panel").count(), 0, "No staff time panel");
  await page.getByRole("button", { name: "Qualify as lead" }).click();
  assert.equal(await page.getByLabel("Sales owner").count(), 0, "No sales owner to choose");
  await page.getByRole("button", { name: "Create the lead" }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/portal/leads/"), { timeout: 60000 });
  ids.lead = new URL(page.url()).pathname.split("/").pop();
  const lead = await must(db.from("lead").select("referredByPartnerId, companyName").eq("id", ids.lead).single(), "Read the lead");
  assert.equal(lead.referredByPartnerId, ids.partner, "Credited to the partner");
  const q = await must(db.from("prospect").select("status, qualifiedLeadId").eq("id", ids.given).single(), "Read the prospect");
  assert.equal(q.status, "QUALIFIED");
  pass("Qualifying makes it the partner's registered lead and opens it in the portal");

  console.log("\n03  New prospect, by a partner");
  await page.goto(`${base}/prospects/new`, { waitUntil: "networkidle" });
  await page.getByLabel("Business name").fill(`QA Typed In ${run}`);
  await page.getByLabel("Email addresses").fill(`qpp-typed-${tag}@example.com`);
  await page.getByLabel("Contact name").fill("Sara Typed");
  await page.getByRole("button", { name: "Add prospect" }).click();
  await page.waitForURL((u) => /\/prospects\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 60000, waitUntil: "commit" });
  const typed = await must(db.from("prospect").select("id, partnerId, ownerUserId").eq("businessName", `QA Typed In ${run}`).single(), "Read the typed prospect");
  assert.equal(typed.partnerId, ids.partner); assert.equal(typed.ownerUserId, ids.admin);
  pass("A partner adds a prospect by hand; it is theirs and opens");
  await page.goto(`${base}/prospects/new`, { waitUntil: "networkidle" });
  await page.getByLabel("Business name").fill(`QA Ours Only ${run}`);
  await page.getByRole("button", { name: "Add prospect" }).click();
  await page.getByText("already in our records").waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole("link", { name: "Open it" }).count(), 0, "No link to ours");
  pass("Adding one of ours is refused without saying whose");

  await page.goto(`${base}/prospects`, { waitUntil: "networkidle" });
  await page.getByLabel(`Select QA Typed In ${run}`).check();
  assert.ok(await page.getByRole("button", { name: "Give to" }).isDisabled(), "Give to waits for a person");
  pass("Give to stays disabled until a person is chosen");

  console.log("\n04  Staff: the partner's page, and New prospect");
  const crm = await must(db.from("security_role").select("id").eq("name", "CRM Admin").single(), "CRM Admin role");
  const staffEmail = `qpp-staff-${tag}@example.com`, staffPassword = randomBytes(24).toString("base64url");
  const sa = await db.auth.admin.createUser({ email: staffEmail, password: staffPassword, email_confirm: true });
  if (sa.error) throw new Error(sa.error.message);
  ids.staff = sa.data.user.id;
  await must(db.from("app_user").insert({ id: ids.staff, fullName: `QA Staff ${run}`, email: staffEmail, roleId: crm.id, userType: "INTERNAL", status: "ACTIVE", updatedAt: now() }), "Staff login");
  const staffPage = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  staffPage.on("dialog", (d) => d.accept());
  await staffPage.goto(`${base}/login`);
  await staffPage.locator('input[name="email"]').fill(staffEmail);
  await staffPage.locator('input[name="password"]').fill(staffPassword);
  await staffPage.locator('button[type="submit"]').click();
  await staffPage.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000, waitUntil: "commit" });

  await staffPage.goto(`${base}/prospects?search=${encodeURIComponent(`QA Ours Only ${run}`)}`, { waitUntil: "networkidle" });
  await staffPage.getByLabel(`Select QA Ours Only ${run}`).check();
  for (const name of ["Assign to partner", "Take back", "Give to"]) assert.equal(await staffPage.getByRole("button", { name }).count(), 0, `No ${name} on Prospects`);
  pass("Selecting prospects on Prospects shows no partner or hand-over controls");

  await staffPage.goto(`${base}/partners/${ids.partner}`, { waitUntil: "networkidle" });
  const panel = staffPage.getByTestId("partner-prospects");
  await panel.getByRole("button", { name: "Give prospects" }).click();
  await panel.getByLabel("Business name").fill(`QA Ours Only ${run}`);
  await panel.getByRole("button", { name: "Search" }).click();
  await panel.getByLabel(`Give QA Ours Only ${run}`).check();
  await panel.getByRole("button", { name: /^Give 1 to/ }).click();
  let given = null;
  for (let i = 0; i < 40 && !given; i++) { await staffPage.waitForTimeout(500); given = (await db.from("prospect").select("partnerId").eq("id", ids.ours).single()).data.partnerId; }
  assert.equal(given, ids.partner);
  pass("Give prospects on the partner's page gives the chosen one");

  await staffPage.goto(`${base}/partners/${ids.partner}`, { waitUntil: "networkidle" });
  await staffPage.getByTestId("partner-prospects").getByLabel(`Take back QA Ours Only ${run}`).check();
  await staffPage.getByTestId("partner-prospects").getByRole("button", { name: /^Take back 1/ }).click();
  let back = "x";
  for (let i = 0; i < 40 && back; i++) { await staffPage.waitForTimeout(500); back = (await db.from("prospect").select("partnerId").eq("id", ids.ours).single()).data.partnerId; }
  assert.equal(back, null);
  pass("Take back on the partner's page returns it");

  await staffPage.goto(`${base}/prospects/new`, { waitUntil: "networkidle" });
  await staffPage.getByLabel("Business name").fill(`QA Ours Only ${run}`);
  await staffPage.getByRole("button", { name: "Add prospect" }).click();
  await staffPage.getByRole("link", { name: "Open it" }).waitFor({ timeout: 30000 });
  pass("Staff adding a duplicate are told it is already a prospect, with a link to it");
  await staffPage.getByLabel("Business name").fill(`QA Staff Typed ${run}`);
  await staffPage.getByRole("button", { name: "Add prospect" }).click();
  await staffPage.waitForURL((u) => /\/prospects\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 60000, waitUntil: "commit" });
  const st = await must(db.from("prospect").select("partnerId").eq("businessName", `QA Staff Typed ${run}`).single(), "Read staff prospect");
  assert.equal(st.partnerId, null);
  pass("Staff add a prospect by hand; it is ours");

  console.log("\nAll checks passed.");
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  const quiet = async (p) => { try { await p; } catch { /* already gone */ } };
  const prospects = [ids.given, ids.theirs, ids.ours];
  for (const t of ["prospect_activity", "prospect_email", "prospect_phone", "prospect_person", "prospect_task", "prospect_campaign_entry"]) await quiet(db.from(t).delete().in("prospectId", prospects));
  await quiet(db.from("prospect").delete().in("id", prospects));
  await quiet(db.from("prospect").delete().like("businessName", `QA Steal ${run}`));
  for (const n of [`QA Typed In ${run}`, `QA Staff Typed ${run}`]) {
    const { data: made } = await db.from("prospect").select("id").eq("businessName", n);
    for (const m of made ?? []) {
      for (const t of ["prospect_email", "prospect_person", "prospect_phone", "prospect_activity"]) await quiet(db.from(t).delete().eq("prospectId", m.id));
      await quiet(db.from("prospect").delete().eq("id", m.id));
    }
  }
  if (ids.lead) { await quiet(db.from("note").delete().eq("relatedEntityId", ids.lead)); await quiet(db.from("lead").delete().eq("id", ids.lead)); }
  for (const key of ["admin", "user", "staff"]) if (ids[key]) { await quiet(db.from("app_user").delete().eq("id", ids[key])); await db.auth.admin.deleteUser(ids[key]).catch(() => {}); }
  await quiet(db.from("partner").delete().eq("id", ids.partner));
  await quiet(db.from("contact").delete().eq("id", ids.person));
  await quiet(db.from("account").delete().eq("id", ids.account));
  console.log("Temporary data removed.");
}
