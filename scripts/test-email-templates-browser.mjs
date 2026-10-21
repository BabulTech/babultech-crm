// Settings → System emails - in a real browser.
//
// An administrator edits the password reset email: an empty subject is
// refused with a message naming the field, a saved edit shows as Edited and
// appears in the preview with sample values, and Reset to default puts the
// built-in wording back. No email is sent. Whatever the template held before
// is restored, and the temporary login is removed.
//
// Usage: node scripts/test-email-templates-browser.mjs http://localhost:3100
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
const KEY = "PASSWORD_RESET";
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
let browser;
let userId = null;
const before = (await db.from("system_email_template").select("*").eq("key", KEY).maybeSingle()).data;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `tmpl-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  userId = auth.data.user.id;
  const ins = await db.from("app_user").insert({ id: userId, fullName: `QA templates ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });
  if (ins.error) throw new Error(ins.error.message);

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("main").getByRole("link", { name: "System emails" }).click();
  await page.waitForURL(/\/settings\/email-templates/);
  for (const name of ["New login: choose your password", "Password reset link", "Contract ready to sign", "Support portal access", "Partner portal access", "Portal password reset"]) {
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).waitFor();
  }
  pass("Settings links to System emails, which lists the six system emails");

  await page.getByRole("button", { name: /Password reset link/ }).click();
  const subject = page.locator('input[name="subject"]');
  await subject.fill("   ");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByText("Please fill in: Subject.").waitFor({ timeout: 20000 });
  pass("An empty subject is refused with a message naming the field");

  await subject.fill(`QA reset subject ${run} for {firstName}`);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(` QA line ${run} for {email}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  let saved = null;
  for (let i = 0; i < 40 && !saved?.subject?.includes(run); i++) {
    await page.waitForTimeout(500);
    saved = (await db.from("system_email_template").select("subject, body, updatedById").eq("key", KEY).maybeSingle()).data;
  }
  await page.waitForLoadState("networkidle");
  assert.equal(saved.subject, `QA reset subject ${run} for {firstName}`);
  assert.ok(saved.body.includes(`QA line ${run}`), "The message edit is saved");
  assert.equal(saved.updatedById, userId);
  await page.getByText("Edited").first().waitFor();
  pass("A saved edit is stored, and the email shows as Edited");

  await page.getByRole("button", { name: /Password reset link/ }).click();
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByText(`QA reset subject ${run} for Samiullah`).waitFor({ timeout: 20000 });
  const frame = page.frameLocator('iframe[title="Preview of Password reset link"]');
  await frame.getByText(`QA line ${run} for samiullah@example.com`).waitFor();
  await frame.getByRole("link", { name: "Set a new password" }).waitFor();
  pass("Preview shows the edit with sample values, and the button is still there");

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  assert.equal((await db.from("system_email_template").select("key").eq("key", KEY).maybeSingle()).data, null);
  pass("Reset to default removes the edit");

  // The marketing templates share the name: their screen must still work.
  await page.goto(`${base}/email/templates`, { waitUntil: "networkidle" });
  const marketing = await page.locator("body").innerText();
  assert.ok(!/permission denied|something went wrong/i.test(marketing), "The marketing Email templates screen loads");
  pass("The marketing Email templates screen still loads");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (before) await db.from("system_email_template").upsert(before);
  else await db.from("system_email_template").delete().eq("key", KEY);
  if (userId) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", userId);
    await db.from("audit_history").delete().eq("changedById", userId);
    await db.from("app_user").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log("Temporary data removed.");
}
