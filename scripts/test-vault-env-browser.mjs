// The vault by project, and whole .env files - in a real browser.
//
// A .env file is pasted as one entry against a project chosen by search; the
// page counts its variables and lists their names; Reveal shows each one with
// Copy, and Copy all gives back the file exactly. A search for a variable name
// finds it, the project filter narrows to it, and the project page links to
// it. An entry with no project is filed under BabulTech Internal.
//
// Needs the local server started with a throwaway SECRET_VAULT_KEY. All
// created rows are removed.
//
// Usage: node scripts/test-vault-env-browser.mjs http://localhost:3100
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
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
async function must(result, what) {
  const r = await result;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
const ids = { project: randomUUID(), user: null };
const varName = `QA_VAR_${run}`;
const envText = [
  "# QA test file",
  `${varName}=first-value`,
  'QUOTED_VALUE="has spaces = and equals"',
  "this line is not a variable",
  "",
  "EMPTY_ONE=",
].join("\n");
let browser;

try {
  const crm = await must(db.from("security_role").select("id").eq("name", "CRM Admin").single(), "CRM Admin");
  const email = `vault-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  ids.user = auth.data.user.id;
  await must(db.from("app_user").insert({ id: ids.user, fullName: `QA vault ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: now() }), "Login");
  await must(db.from("project").insert({ id: ids.project, projectNumber: `QA-V-${run}`, name: `QA Vault Project ${run}`, projectManagerId: ids.user, projectType: "INTERNAL", billingType: "FIXED", status: "ACTIVE", updatedAt: now() }), "Project");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  // Add a whole .env file against the project, chosen by search.
  await page.goto(`${base}/vault/new`, { waitUntil: "networkidle" });
  await page.locator('input[name="name"]').fill(`QA env ${run}`);
  await page.locator('input[name="service"]').fill("QA app");
  await page.locator('select[name="kind"]').selectOption("ENV_FILE");
  await page.getByRole("button", { name: "BabulTech Internal" }).click();
  await page.getByPlaceholder(/Search projects/).fill(`QA Vault Project ${run}`);
  await page.getByRole("option", { name: new RegExp(`QA Vault Project ${run}`) }).click();
  await page.locator('textarea[name="value"]').fill(envText);
  await page.getByText(/3 variables found · line 4 is not NAME=value/).waitFor();
  pass("Pasting a .env file counts its variables and flags a line that is not one");
  await page.getByRole("button", { name: "Add to the vault" }).click();
  await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const secretId = page.url().split("/").pop();
  const row = await must(db.from("secret").select("projectId, envKeys, valueHint, kind").eq("id", secretId).single(), "Saved");
  assert.equal(row.projectId, ids.project);
  assert.equal(row.kind, "ENV_FILE");
  assert.deepEqual(row.envKeys, [varName, "QUOTED_VALUE", "EMPTY_ONE"]);
  assert.equal(row.valueHint, null, "No hint for a file");
  await page.getByText(`QA Vault Project ${run}`).first().waitFor();
  await page.getByText(varName, { exact: true }).waitFor();
  pass("Saved as one entry on the project, with the variable names listed and no value hint");

  // Reveal: each variable, and Copy all gives back the file exactly.
  await page.getByRole("button", { name: "Reveal the value" }).click();
  await page.getByRole("button", { name: "Copy all" }).waitFor({ timeout: 20000 });
  await page.getByText("has spaces = and equals").waitFor();
  await page.getByRole("button", { name: "Copy all" }).click();
  // Windows clipboards turn LF into CRLF on their own.
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), envText);
  await page.getByRole("button", { name: `Copy ${varName}` }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "first-value");
  await page.getByRole("button", { name: "Download .env" }).waitFor();
  pass("Reveal lists each variable with Copy; Copy all returns the file exactly as pasted");

  // Find it: by variable name, and by project.
  await page.goto(`${base}/vault?search=${varName}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `QA env ${run}` }).waitFor();
  await page.goto(`${base}/vault?search=${varName.toLowerCase()}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `QA env ${run}` }).waitFor();
  await page.goto(`${base}/vault?project=${ids.project}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `QA env ${run}` }).waitFor();
  pass("Searching a variable name finds the file, and the project filter narrows to it");

  // The project page links to its vault entries.
  await page.goto(`${base}/projects/${ids.project}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Vault (1)" }).click();
  await page.waitForURL(new RegExp(`/vault\\?project=${ids.project}`));
  pass("The project page shows Vault (1) and opens the project's entries");

  // No project chosen: BabulTech Internal.
  await page.goto(`${base}/vault/new`, { waitUntil: "networkidle" });
  await page.locator('input[name="name"]').fill(`QA internal key ${run}`);
  await page.locator('input[name="service"]').fill("QA service");
  await page.locator('input[name="value"]').fill("sk-test-1234567890");
  await page.getByRole("button", { name: "Add to the vault" }).click();
  await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const internal = page.url().split("/").pop();
  assert.equal((await must(db.from("secret").select("projectId").eq("id", internal).single(), "Internal")).projectId, null);
  await page.getByText("BabulTech Internal").first().waitFor();
  await page.goto(`${base}/vault?project=internal`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `QA internal key ${run}` }).waitFor();
  assert.equal(await page.getByRole("link", { name: `QA env ${run}` }).count(), 0);
  pass("With no project chosen it is filed under BabulTech Internal");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (ids.user) {
    const { data: mine } = await db.from("secret").select("id").eq("createdById", ids.user);
    const secretIds = (mine ?? []).map((s) => s.id);
    if (secretIds.length) {
      await db.from("secret_access_log").delete().in("secretId", secretIds);
      await db.from("audit_history").delete().in("entityId", secretIds);
      await db.from("secret").delete().in("id", secretIds);
    }
  }
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
