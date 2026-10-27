// Prospecting, phase 1 - in a real browser.
//
// The prospects list shows real totals and pages through the database;
// search finds a prospect by phone; a spreadsheet imports into a new dataset
// (columns recognised, the rest kept as extra fields), and importing it again
// skips every row as already there; a prospect's page takes phones, emails,
// decision makers and tags. Only prospects this test imports are edited, and
// they, their dataset and the temporary login are removed afterwards.
//
// Usage: node scripts/test-prospects-browser.mjs http://localhost:3100
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

config({ path: ".env", quiet: true });
const base = process.argv[2] || "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("This check only targets the local application.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const run = randomUUID().slice(0, 6).toUpperCase();
const passed = [];
const errors = [];
const pass = (what) => { passed.push(what); console.log(`  PASS  ${what}`); };
const fmt = (n) => new Intl.NumberFormat("en-US").format(n);
let browser;
let userId = null;
const datasetName = `QA dataset ${run}`;

try {
  const crm = (await db.from("security_role").select("id").eq("name", "CRM Admin").single()).data;
  const email = `prospects-${run.toLowerCase()}@example.com`;
  const password = `Pw-${randomBytes(12).toString("base64url")}9a`;
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (auth.error) throw new Error(auth.error.message);
  userId = auth.data.user.id;
  const ins = await db.from("app_user").insert({ id: userId, fullName: `QA prospects ${run}`, email, roleId: crm.id, status: "ACTIVE", updatedAt: new Date().toISOString() });
  if (ins.error) throw new Error(ins.error.message);

  // A small sheet: name, phone, email, website, a category, and a column the CRM has no field for.
  const sheet = [
    { "Business Name": `QA Dental ${run} One`, Phone: "+1 416-555-0101", Email: `one-${run.toLowerCase()}@example.com`, Website: `https://qa-one-${run.toLowerCase()}.example.com`, Category: "Dentist", "Chairs": "4" },
    { "Business Name": `QA Dental ${run} Two`, Phone: "+1 416-555-0102", Email: "", Website: "", Category: "Dentist", "Chairs": "2" },
    { "Business Name": `QA Dental ${run} Three`, Phone: "", Email: `three-${run.toLowerCase()}@example.com`, Website: "", Category: "Orthodontist", "Chairs": "6" },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), "Clinics");
  const file = join(mkdtempSync(join(tmpdir(), "qa-prospects-")), `qa-${run}.xlsx`);
  writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.on("pageerror", (e) => errors.push({ url: page.url(), message: e.message }));
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 });

  // The list: real totals, paged.
  const { count: active } = await db.from("prospect").select("id", { count: "exact", head: true }).is("deletedAt", null).eq("status", "ACTIVE");
  await page.goto(`${base}/prospects`, { waitUntil: "networkidle" });
  await page.getByText(fmt(active), { exact: true }).first().waitFor();
  await page.getByText(`1–50 of ${fmt(active)}`).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 50);
  await page.getByRole("link", { name: "Next" }).click();
  await page.getByText(`51–100 of ${fmt(active)}`).waitFor();
  pass(`The list counts every prospect (${fmt(active)}) and pages through them 50 at a time`);

  const sample = (await db.from("prospect_phone").select("phone, prospect:prospect ( businessName )").limit(1).single()).data;
  const digits = sample.phone.replace(/\D/g, "").slice(-7);
  await page.goto(`${base}/prospects?search=${digits}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: sample.prospect.businessName }).first().waitFor();
  pass("Search finds a prospect by part of its phone number");

  // Import.
  await page.goto(`${base}/prospects/import`, { waitUntil: "networkidle" });
  await page.getByLabel("Spreadsheet file").setInputFiles(file);
  await page.getByText("3 rows in “Clinics”").waitFor();
  assert.equal(await page.getByLabel("Import Business Name as").inputValue(), "businessName");
  assert.equal(await page.getByLabel("Import Phone as").inputValue(), "phone");
  assert.equal(await page.getByLabel("Import Email as").inputValue(), "email");
  assert.equal(await page.getByLabel("Import Website as").inputValue(), "website");
  assert.equal(await page.getByLabel("Import Category as").inputValue(), "industry");
  assert.equal(await page.getByLabel("Import Chairs as").inputValue(), "custom");
  await page.getByPlaceholder(`qa-${run}`).fill(datasetName);
  await page.getByRole("button", { name: "Import 3 prospects" }).click();
  await page.getByText("Imported 3 new, updated 0, skipped 0 already here").waitFor({ timeout: 60000 });
  const dataset = (await db.from("prospect_dataset").select("id").eq("name", datasetName).single()).data;
  const mine = (await db.from("prospect").select("id, businessName, industry, customFields, websiteNorm").eq("datasetId", dataset.id)).data;
  assert.equal(mine.length, 3);
  const one = mine.find((p) => p.businessName.endsWith("One"));
  assert.equal(one.industry, "Dentist");
  assert.equal(one.customFields.Chairs, "4");
  assert.equal(one.websiteNorm, `qa-one-${run.toLowerCase()}.example.com`);
  pass("A spreadsheet imports into a new dataset, columns recognised and the rest kept as extra fields");

  await page.goto(`${base}/prospects/import`, { waitUntil: "networkidle" });
  await page.getByLabel("Spreadsheet file").setInputFiles(file);
  await page.getByText("3 rows in “Clinics”").waitFor();
  await page.locator("select").filter({ has: page.locator(`option:text-is("${datasetName}")`) }).first().selectOption({ label: datasetName });
  await page.getByRole("button", { name: "Import 3 prospects" }).click();
  await page.getByText("Imported 0 new, updated 0, skipped 3 already here").waitFor({ timeout: 60000 });
  pass("Importing the same file again skips every row as already there");

  // A prospect's page.
  await page.goto(`${base}/prospects/${one.id}`, { waitUntil: "networkidle" });
  await page.getByText("Chairs").waitFor();
  await page.getByLabel("New phone").fill("+1 647 555 0199");
  await page.getByLabel("Phone label").fill("Front desk");
  await page.getByLabel("New phone").press("Enter");
  await page.getByText("+1 647 555 0199").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Add person" }).click();
  await page.locator('input[name="name"]').fill("Dr QA Owner");
  await page.locator('input[name="role"]').fill("Owner");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Dr QA Owner").waitFor({ timeout: 20000 });
  await page.getByLabel("New tag").fill(`QA tag ${run}`);
  await page.getByLabel("New tag").press("Enter");
  await page.getByText(`QA tag ${run}`).waitFor({ timeout: 20000 });
  const after = (await db.from("prospect").select("tags, phones:prospect_phone ( phone, label ), people:prospect_person ( name, role, \"isPrimary\" )").eq("id", one.id).single()).data;
  assert.ok(after.tags.includes(`QA tag ${run}`));
  assert.ok(after.phones.some((p) => p.label === "Front desk"));
  assert.ok(after.people.some((p) => p.name === "Dr QA Owner" && p.isPrimary));
  pass("A prospect's page takes another phone, a decision maker and a tag");

  await page.goto(`${base}/prospects/datasets`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: datasetName }).waitFor();
  pass("The dataset is listed with its counts");

  assert.equal(errors.length, 0, `Browser errors:\n${errors.map((e) => `  ${e.url}: ${e.message.slice(0, 200)}`).join("\n")}`);
  pass("No browser runtime errors");
  console.log(`\n${passed.length} checks passed.\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  const { data: ds } = await db.from("prospect_dataset").select("id").eq("name", datasetName);
  for (const d of ds ?? []) {
    await db.from("prospect").delete().eq("datasetId", d.id);
    await db.from("prospect_dataset").delete().eq("id", d.id);
  }
  if (userId) {
    for (const t of ["notification", "record_follow", "recent_record", "login_event", "favorite_record", "user_preference"]) await db.from(t).delete().eq("userId", userId);
    await db.from("audit_history").delete().eq("changedById", userId);
    await db.from("app_user").delete().eq("id", userId);
    await db.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log("Temporary data removed.");
}
