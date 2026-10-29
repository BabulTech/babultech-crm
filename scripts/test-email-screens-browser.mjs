// Email from a record page - in a real browser.
//
// A CRM Admin opens a temporary lead, writes an email with a CC and an
// attached file, and sends it. The address is example.com, so the email is
// recorded but never delivered. Then Settings -> Email on screens limits Lead
// to the CRM Admin role, and someone with another role no longer sees New
// email. The setting is put back and everything temporary is removed.
//
// Usage: node scripts/test-email-screens-browser.mjs http://localhost:3100
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
const ids = { users: [], role: randomUUID(), lead: randomUUID(), account: randomUUID(), contact: randomUUID(), prospects: [randomUUID(), randomUUID()] };
let browser;
let savedSetting;

async function makeUser(name, roleId) {
  const email = `mailscreen-${name}-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  await db.from("app_user").insert({ id: auth.data.user.id, fullName: `QA ${name} ${run}`, email, roleId, status: "ACTIVE", updatedAt: new Date().toISOString() });
  ids.users.push(auth.data.user.id);
  return { email, password, id: auth.data.user.id };
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
  savedSetting = (await db.from("email_screen_setting").select("*").eq("entityType", "Lead").maybeSingle()).data;
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  await db.from("security_role").insert({ id: ids.role, name: `QA Sales ${run}`, permissions: ["lead:read", "lead:write"], dataScope: "ALL", updatedAt: new Date().toISOString() });
  const admin = await makeUser("admin", crm.id);
  const seller = await makeUser("seller", ids.role);
  const leadEmail = `mailscreen-lead-${run.toLowerCase()}@example.com`;
  const ins = await db.from("lead").insert({
    id: ids.lead, leadNumber: `QA-MAIL-${run}`, firstName: "Sana", lastName: `Tester ${run}`, companyName: `QA Mail Co ${run}`,
    email: leadEmail, status: "NEW", ownerUserId: admin.id, updatedAt: new Date().toISOString(),
  });
  if (ins.error) throw new Error(ins.error.message);
  await db.from("email_screen_setting").upsert({ entityType: "Lead", enabled: true, roleIds: [], defaultSenderId: null, defaultTemplateId: null });

  browser = await chromium.launch({ headless: true });
  const page = await signIn(admin);
  await page.goto(`${base}/leads/${ids.lead}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New email" }).click();
  await page.getByText(leadEmail).first().waitFor();
  pass("A lead page has an Emails panel; New email opens with the lead's address in To");

  await page.getByRole("button", { name: "Add CC or BCC" }).click();
  await page.getByLabel("CC", { exact: true }).fill(`mailscreen-cc-${run.toLowerCase()}@example.com`);
  await page.getByLabel("CC", { exact: true }).press("Enter");
  await page.getByLabel("Subject").fill(`Hello {firstName} ${run}`);
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type("Thanks for your time, {firstName}.");
  await page.getByLabel("Attach files").setInputFiles({ name: `brief-${run}.txt`, mimeType: "text/plain", buffer: Buffer.from("A short brief.") });
  await page.getByText(`brief-${run}.txt`).waitFor();
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Done" }).waitFor({ timeout: 60000 });
  pass("The email is written with CC, a placeholder and an attachment, and sent");

  const { data: mail } = await db.from("email").select("id, subject, \"toAddresses\", \"ccAddresses\", status, \"sentById\"").eq("relatedEntityId", ids.lead).single();
  assert.equal(mail.subject, `Hello Sana ${run}`);
  assert.deepEqual(mail.toAddresses, [leadEmail]);
  assert.equal(mail.ccAddresses.length, 1);
  assert.equal(mail.sentById, admin.id);
  const { data: att } = await db.from("email_attachment").select("fileName, documentId").eq("emailId", mail.id);
  assert.equal(att.length, 1);
  assert.equal(att[0].fileName, `brief-${run}.txt`);
  ids.document = att[0].documentId;
  pass(`It is recorded on the lead (status ${mail.status}) with the subject filled in and the file kept`);

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText(`Hello Sana ${run}`, { exact: true }).waitFor();
  pass("The sent email is listed in the lead's Emails panel");

  const contactEmail = `mailscreen-contact-${run.toLowerCase()}@example.com`;
  const acc = await db.from("account").insert({ id: ids.account, accountNumber: `QA-MAIL-${run}`, name: `QA Mail Account ${run}`, accountType: "CUSTOMER", ownerUserId: admin.id, updatedAt: new Date().toISOString() });
  if (acc.error) throw new Error(acc.error.message);
  const con = await db.from("contact").insert({ id: ids.contact, accountId: ids.account, firstName: "Bilal", lastName: `Buyer ${run}`, email: contactEmail, isPrimary: true, updatedAt: new Date().toISOString() });
  if (con.error) throw new Error(con.error.message);
  await page.goto(`${base}/accounts/${ids.account}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New email" }).click();
  await page.locator("form").filter({ has: page.getByLabel("Subject") }).getByText(contactEmail).first().waitFor();
  pass("A customer account's page offers New email with the account's contacts as recipients");

  // Mass email to prospects: two businesses, one archived and so left out.
  for (const [pid, status, who] of [[ids.prospects[0], "ACTIVE", "Ayesha Khan"], [ids.prospects[1], "ARCHIVED", "Omar Ali"]]) {
    const pr = await db.from("prospect").insert({ id: pid, businessName: `QA Bulk ${who} ${run}`, status });
    if (pr.error) throw new Error(pr.error.message);
    const pp = await db.from("prospect_person").insert({ prospectId: pid, name: who, email: `mailscreen-${pid.slice(0, 8)}@example.com`, isPrimary: true });
    if (pp.error) throw new Error(pp.error.message);
  }
  await page.goto(`${base}/email/compose?type=Prospect&ids=${ids.prospects.join(",")}`, { waitUntil: "networkidle" });
  await page.locator("input[maxlength='300']").fill(`Bulk hello ${run}`);
  await page.locator("textarea").first().fill("Hello {{firstName}} at {{companyName}}.");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Send to 1 person" }).click();
  await page.waitForURL(/\/leads\/email\/sends\//, { timeout: 60000 }).catch(async (e) => {
    throw new Error(`${e.message.split("\n")[0]} -- page says: ${(await page.locator("main").innerText()).slice(-900)}`);
  });
  const { data: acts } = await db.from("activity").select("relatedEntityType, relatedEntityId").eq("relatedEntityId", ids.prospects[0]);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].relatedEntityType, "Prospect");
  const { data: touches } = await db.from("prospect_activity").select("type").eq("prospectId", ids.prospects[0]);
  assert.ok(touches.some((t) => t.type === "EMAIL_SENT"));
  pass("Mass email to prospects sends to the active one, leaves out the archived one, and logs outreach");

  await page.goto(`${base}/settings/email-screens`, { waitUntil: "networkidle" });
  const card = page.locator('[data-screen="Lead"]');
  await card.getByLabel("CRM Admin", { exact: true }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByText("Saved.").waitFor();
  const after = (await db.from("email_screen_setting").select("roleIds").eq("entityType", "Lead").single()).data;
  assert.deepEqual(after.roleIds, [crm.id]);
  pass("Settings -> Email on screens limits Lead emails to CRM Admin");

  const other = await signIn(seller);
  await other.goto(`${base}/leads/${ids.lead}`, { waitUntil: "networkidle" });
  await other.getByText(`Hello Sana ${run}`, { exact: true }).waitFor();
  assert.equal(await other.getByRole("button", { name: "New email" }).count(), 0);
  pass("Someone in another role still sees the history but no New email button");

  await other.goto(`${base}/email/compose?type=Lead&ids=${ids.lead}`, { waitUntil: "networkidle" });
  await other.getByText("switched off for your role").waitFor();
  pass("The same limit stops them mass-emailing leads from the list");

  assert.deepEqual(errors, []);
  console.log(`\nAll ${passed.length} checks passed.`);
} catch (e) {
  console.error("FAILED:", e.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (savedSetting) await db.from("email_screen_setting").upsert(savedSetting);
  const mails = (await db.from("email").select("id").eq("relatedEntityId", ids.lead)).data ?? [];
  for (const m of mails) await db.from("email").delete().eq("id", m.id);
  const docs = (await db.from("document").select("id, \"storageUrl\"").eq("relatedEntityId", ids.lead)).data ?? [];
  if (docs.length) await db.storage.from("documents").remove(docs.map((d) => d.storageUrl).filter(Boolean));
  await db.from("document").delete().eq("relatedEntityId", ids.lead);
  await db.from("lead").delete().eq("id", ids.lead);
  await db.from("contact").delete().eq("id", ids.contact);
  await db.from("account").delete().eq("id", ids.account);
  const batches = (await db.from("activity").select("batchId").in("relatedEntityId", ids.prospects)).data ?? [];
  await db.from("activity").delete().in("relatedEntityId", ids.prospects);
  for (const b of batches) if (b.batchId) await db.from("email_batch").delete().eq("id", b.batchId);
  await db.from("job").delete().like("title", `Email: Bulk hello ${run}`);
  await db.from("prospect_activity").delete().in("prospectId", ids.prospects);
  await db.from("prospect_person").delete().in("prospectId", ids.prospects);
  await db.from("prospect").delete().in("id", ids.prospects);
  for (const id of ids.users) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", id);
    await db.from("audit_history").delete().eq("changedById", id);
    await db.from("app_user").delete().eq("id", id);
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  await db.from("security_role").delete().eq("id", ids.role);
  console.log("Temporary data removed.");
}
