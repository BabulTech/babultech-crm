"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase";
import { SEQUENCES } from "@/lib/numbering";
import { authorize, PERMISSIONS } from "@/lib/authz";
import type { ActionResult } from "./partners";

/**
 * Bulk import of what the company already owns, from the Excel template
 * (/api/inventory/template, built by lib/inventory-template.ts).
 *
 * Called twice: first with commit=false to check every row and show the
 * problems, then with commit=true to save. Nothing is saved unless every row
 * is clean, so a file is never half imported.
 *
 * Unknown types, categories and places are created. People must match an
 * active staff member by email or full name. Items already owned carry no
 * money record; a row may instead name the expense that bought it, and the
 * file cannot put more against an expense than it was for. Hand-overs from
 * the file are recorded as already received: the person has had the item.
 */

const db = () => supabaseAdmin();
const now = () => new Date().toISOString();

/** Template header -> field. Matching ignores case, spaces, * and punctuation. */
const COLUMNS: Record<string, string> = {
  itemname: "name", name: "name",
  type: "type", category: "category", tracked: "tracked",
  quantity: "quantity", qty: "quantity",
  brand: "brand", model: "model", serialnumber: "serial", serial: "serial",
  keptat: "keptAt", location: "keptAt", condition: "condition",
  giventoperson: "person", giventoplace: "place", quantitygiven: "quantityGiven",
  howwegotit: "how", purchasedate: "purchaseDate", costofeach: "cost", cost: "cost",
  currency: "currency", boughtfrom: "supplier", invoicereceiptno: "invoice", invoicereceiptnumber: "invoice",
  expensenumber: "expense", purchasedetails: "details",
  warrantyends: "warranty", licencerenews: "licence", licenserenews: "licence", notes: "notes",
};

export interface ImportRowResult {
  row: number;
  name: string;
  summary: string;
  errors: string[];
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const clean = (v: unknown) => (v == null ? "" : String(v).trim());

function toDay(v: string): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // Excel serial day number.
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  // dd/mm/yyyy or dd-mm-yyyy (Pakistan writes the day first).
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

const CONDITION: Record<string, string> = { new: "NEW", good: "GOOD", needsrepair: "NEEDS_REPAIR", repair: "NEEDS_REPAIR", broken: "BROKEN" };
const HOW: Record<string, string> = { alreadyhad: "EXISTING", existing: "EXISTING", "": "EXISTING", gift: "GIFT", free: "GIFT", purchased: "PURCHASED", bought: "PURCHASED" };

export async function importInventory(
  rawRows: Record<string, unknown>[],
  commit: boolean,
): Promise<ActionResult<{ rows: ImportRowResult[]; items: number; created: number }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  if (!Array.isArray(rawRows) || rawRows.length === 0) return { ok: false, error: "The file has no rows under the headings." };
  if (rawRows.length > 2000) return { ok: false, error: "Import at most 2,000 rows at a time. Split the file." };

  const [types, categories, locations, users, currencies] = await Promise.all([
    db().from("asset_type").select("id, name, tracking, categoryId"),
    db().from("asset_category").select("id, name"),
    db().from("asset_location").select("id, name"),
    db().from("app_user").select("id, fullName, email, userType, partnerId").eq("status", "ACTIVE").is("deletedAt", null),
    db().from("currency").select("code"),
  ]);
  const typeBy = new Map((types.data ?? []).map((t) => [t.name.toLowerCase(), t]));
  const catBy = new Map((categories.data ?? []).map((c) => [c.name.toLowerCase(), c]));
  const placeBy = new Map((locations.data ?? []).map((l) => [l.name.toLowerCase(), l]));
  const staff = (users.data ?? []).filter((u) => (!u.userType || u.userType === "INTERNAL") && !u.partnerId);
  const currencyOk = new Set((currencies.data ?? []).map((c) => c.code));
  currencyOk.add("PKR");

  // Expenses named in the file, and what is already put against them.
  const expenseNumbers = [...new Set(rawRows.map((r) => clean(Object.entries(r).find(([k]) => key(k) === "expensenumber")?.[1]).toUpperCase()).filter(Boolean))];
  const expenseBy = new Map<string, { id: string; amount: number; currencyCode: string; left: number }>();
  if (expenseNumbers.length) {
    const { data } = await db().from("expense").select("id, expenseNumber, amount, currencyCode, approvalStatus, deletedAt").in("expenseNumber", expenseNumbers);
    for (const e of data ?? []) {
      if (e.deletedAt || e.approvalStatus === "REJECTED") continue;
      const [{ data: a }, { data: s }] = await Promise.all([
        db().from("asset").select("purchaseCost").eq("expenseId", e.id).is("deletedAt", null),
        db().from("asset_event").select("cost").eq("expenseId", e.id).eq("kind", "STOCK_IN"),
      ]);
      const used = (a ?? []).reduce((t, x) => t + Number(x.purchaseCost), 0) + (s ?? []).reduce((t, x) => t + Number(x.cost ?? 0), 0);
      expenseBy.set(e.expenseNumber.toUpperCase(), { id: e.id, amount: Number(e.amount), currencyCode: e.currencyCode, left: Number(e.amount) - used });
    }
  }

  type Plan = {
    row: number; name: string; typeName: string; typeId: string | null; tracking: string; categoryName: string;
    quantity: number; brand: string | null; model: string | null; serial: string | null; keptAt: string | null;
    condition: string; person: string | null; place: string | null; quantityGiven: number;
    acquisition: string; purchaseDate: string; cost: number; currency: string; supplier: string | null;
    invoice: string | null; expenseId: string | null; details: string | null; warranty: string | null; licence: string | null; notes: string | null;
  };
  const plans: Plan[] = [];
  const results: ImportRowResult[] = [];
  const newTypes = new Map<string, { tracking: string; category: string }>();

  rawRows.forEach((raw, i) => {
    const row = i + 2; // heading is row 1
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const field = COLUMNS[key(k)];
      if (field) f[field] = clean(v);
    }
    if (Object.values(f).every((v) => !v)) return; // blank line
    const errors: string[] = [];
    const name = f.name;
    if (!name) errors.push("Item name is empty.");
    if (name && name.length > 150) errors.push("Item name is longer than 150 characters.");

    const typeName = f.type;
    let tracking = "INDIVIDUAL";
    let typeId: string | null = null;
    let categoryName = f.category || "";
    if (!typeName) errors.push("Type is empty.");
    else {
      const t = typeBy.get(typeName.toLowerCase());
      if (t) {
        typeId = t.id; tracking = t.tracking;
        categoryName = (categories.data ?? []).find((c) => c.id === t.categoryId)?.name ?? categoryName;
      } else {
        const tr = key(f.tracked ?? "");
        tracking = tr.startsWith("count") || tr === "quantity" ? "QUANTITY" : "INDIVIDUAL";
        const planned = newTypes.get(typeName.toLowerCase());
        if (planned) tracking = planned.tracking;
        else newTypes.set(typeName.toLowerCase(), { tracking, category: categoryName || "Other" });
        categoryName = categoryName || "Other";
      }
    }

    const quantity = f.quantity ? Number(f.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) errors.push("Quantity must be a whole number from 1 to 500.");

    const condition = f.condition ? CONDITION[key(f.condition)] : "GOOD";
    if (!condition) errors.push(`Condition "${f.condition}" is not one of New, Good, Needs repair, Broken.`);

    const how = HOW[key(f.how ?? "")];
    if (!how) errors.push(`How we got it "${f.how}" is not one of Already had, Gift, Purchased.`);

    const purchaseDate = toDay(f.purchaseDate ?? "");
    if (!f.purchaseDate) errors.push("Purchase date is empty. Use your best guess for older items.");
    else if (!purchaseDate) errors.push(`Purchase date "${f.purchaseDate}" is not a date (use 2024-03-15 or 15/03/2024).`);
    else if (purchaseDate > new Date().toISOString().slice(0, 10)) errors.push("Purchase date is in the future.");

    const cost = f.cost ? Number(f.cost.replace(/,/g, "")) : NaN;
    if (!f.cost) errors.push("Cost of each is empty. Use an estimate for older items.");
    else if (Number.isNaN(cost) || cost < 0) errors.push(`Cost "${f.cost}" is not a number.`);

    let currency = (f.currency || "PKR").toUpperCase();
    let expenseId: string | null = null;
    if (f.expense) {
      const e = expenseBy.get(f.expense.toUpperCase());
      if (!e) errors.push(`Expense ${f.expense} was not found, or was rejected.`);
      else if (!Number.isNaN(cost)) {
        const total = cost * (Number.isInteger(quantity) ? quantity : 1);
        if (total > e.left + 0.005) errors.push(`Expense ${f.expense} only has ${e.left.toFixed(2)} left to put against items; this row is ${total.toFixed(2)}.`);
        else { e.left -= total; expenseId = e.id; currency = e.currencyCode; }
      }
    } else if (how === "PURCHASED") {
      errors.push("Purchased items need the Expense number that paid for them. Otherwise use Already had.");
    }
    if (!currencyOk.has(currency)) errors.push(`Currency "${currency}" is not set up.`);

    const warranty = f.warranty ? toDay(f.warranty) : null;
    if (f.warranty && !warranty) errors.push(`Warranty ends "${f.warranty}" is not a date.`);
    const licence = f.licence ? toDay(f.licence) : null;
    if (f.licence && !licence) errors.push(`Licence renews "${f.licence}" is not a date.`);

    let person: string | null = null;
    if (f.person) {
      const p = f.person.toLowerCase();
      const matches = staff.filter((u) => u.email?.toLowerCase() === p || u.fullName?.toLowerCase() === p);
      if (matches.length === 1) person = matches[0].id;
      else if (matches.length > 1) errors.push(`"${f.person}" matches several people. Use their email.`);
      else errors.push(`"${f.person}" is not an active staff member. Use their CRM email or full name.`);
    }
    if (f.person && f.place) errors.push("Give it to a person or a place, not both.");
    const quantityGiven = f.quantityGiven ? Number(f.quantityGiven) : (person || f.place ? quantity : 0);
    if (!Number.isInteger(quantityGiven) || quantityGiven < 0 || quantityGiven > quantity) errors.push("Quantity given must be a whole number no more than Quantity.");
    if (serialProblem(tracking, quantity, f.serial)) errors.push("A serial number belongs to one item. Put each serial on its own row with Quantity 1.");

    const summary = [
      tracking === "INDIVIDUAL" && quantity > 1 ? `${quantity} separate items` : tracking === "QUANTITY" ? `${quantity} counted` : "1 item",
      typeName && !typeBy.has(typeName.toLowerCase()) ? `new type "${typeName}" (${categoryName}, ${tracking === "QUANTITY" ? "counted" : "one by one"})` : typeName,
      f.keptAt && `at ${f.keptAt}${placeBy.has(f.keptAt.toLowerCase()) ? "" : " (new place)"}`,
      f.person && `given to ${f.person}`,
      f.place && `given to ${f.place}${placeBy.has(f.place.toLowerCase()) ? "" : " (new place)"}`,
      expenseId ? `paid by ${f.expense}` : how === "GIFT" ? "gift" : "already owned",
    ].filter(Boolean).join(" · ");

    results.push({ row, name: name || "(no name)", summary, errors });
    if (errors.length === 0) {
      plans.push({
        row, name, typeName, typeId, tracking, categoryName, quantity, brand: f.brand || null, model: f.model || null,
        serial: f.serial || null, keptAt: f.keptAt || null, condition, person, place: f.place || null, quantityGiven,
        acquisition: expenseId ? "PURCHASED" : how === "GIFT" ? "GIFT" : "EXISTING",
        purchaseDate: purchaseDate!, cost, currency, supplier: f.supplier || null, invoice: f.invoice || null, expenseId,
        details: f.details || (expenseId ? null : "Imported from the inventory spreadsheet."), warranty, licence, notes: f.notes || null,
      });
    }
  });

  const items = plans.reduce((t, p) => t + (p.tracking === "INDIVIDUAL" ? p.quantity : 1), 0);
  const failed = results.some((r) => r.errors.length);
  if (!commit || failed) return { ok: true, data: { rows: results, items, created: 0 } };

  // --- Save -----------------------------------------------------------------
  const ensureCategory = async (name: string) => {
    const hit = catBy.get(name.toLowerCase());
    if (hit) return hit.id;
    const { data, error } = await db().from("asset_category").insert({ name, sortOrder: 50 }).select("id, name").single();
    if (error) throw new Error(`Category ${name}: ${error.message}`);
    catBy.set(name.toLowerCase(), data);
    return data.id;
  };
  const ensurePlace = async (name: string) => {
    const hit = placeBy.get(name.toLowerCase());
    if (hit) return hit.id;
    const { data, error } = await db().from("asset_location").insert({ name }).select("id, name").single();
    if (error) throw new Error(`Place ${name}: ${error.message}`);
    placeBy.set(name.toLowerCase(), data);
    return data.id;
  };
  const ensureType = async (p: Plan) => {
    const hit = typeBy.get(p.typeName.toLowerCase());
    if (hit) return hit.id;
    const categoryId = await ensureCategory(p.categoryName);
    const { data, error } = await db().from("asset_type").insert({ name: p.typeName, categoryId, tracking: p.tracking }).select("id, name, tracking, categoryId").single();
    if (error) throw new Error(`Type ${p.typeName}: ${error.message}`);
    typeBy.set(p.typeName.toLowerCase(), data);
    return data.id;
  };

  let created = 0;
  const touched: string[] = [];
  try {
    for (const p of plans) {
      const typeId = await ensureType(p);
      const locationId = p.keptAt ? await ensurePlace(p.keptAt) : null;
      const givenPlace = p.place ? await ensurePlace(p.place) : null;
      const records = p.tracking === "INDIVIDUAL" ? p.quantity : 1;
      for (let i = 0; i < records; i++) {
        const { data: tag, error: tagError } = await db().rpc("next_sequence_number", { p_entity_type: SEQUENCES.ASSET });
        if (tagError) throw new Error(tagError.message);
        const quantity = p.tracking === "INDIVIDUAL" ? 1 : p.quantity;
        const given = p.tracking === "INDIVIDUAL" ? (i < p.quantityGiven ? 1 : 0) : p.quantityGiven;
        const { data: asset, error } = await db().from("asset").insert({
          assetTag: tag, name: p.name, typeId, tracking: p.tracking, brand: p.brand, model: p.model,
          serialNumber: p.tracking === "INDIVIDUAL" && p.quantity === 1 ? p.serial : null,
          quantity, locationId, condition: p.condition,
          status: given > 0 && given >= quantity ? "ASSIGNED" : "IN_STOCK",
          acquisition: p.acquisition, purchaseDate: p.purchaseDate,
          purchaseCost: Math.round(p.cost * quantity * 100) / 100, currencyCode: p.currency,
          supplierName: p.supplier, invoiceReference: p.invoice, purchaseDetails: p.details, expenseId: p.expenseId,
          warrantyEndsOn: p.warranty, licenceExpiresOn: p.licence, notes: p.notes, createdById: auth.user.id,
        }).select("id").single();
        if (error) throw new Error(`Row ${p.row}: ${error.message}`);
        touched.push(asset.id);
        created++;
        await db().from("asset_event").insert({ assetId: asset.id, kind: "CREATED", actorId: auth.user.id, quantityChange: quantity, note: `Imported from spreadsheet row ${p.row}.` });
        if (given > 0 && (p.person || givenPlace)) {
          await db().from("asset_assignment").insert({
            assetId: asset.id, quantity: given, assigneeUserId: p.person, locationId: p.person ? null : givenPlace,
            assignedById: auth.user.id, conditionOut: p.condition, note: "Already with them when the inventory was imported.",
            acceptStatus: "ACCEPTED", acceptedAt: now(),
          });
        }
      }
    }
  } catch (err) {
    // All or nothing: remove what this run saved. New types and places stay; they are harmless.
    if (touched.length) await db().from("asset").delete().in("id", touched);
    return { ok: false, error: `Nothing was imported: ${err instanceof Error ? err.message : "unknown error"}` };
  }

  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "Asset", entityId: touched[0], fieldName: "imported",
    oldValue: null, newValue: `${created} records from a spreadsheet`, changedById: auth.user.id, source: "IMPORT", changedAt: now(),
  });
  revalidatePath("/inventory");
  revalidatePath("/inventory/mine");
  return { ok: true, data: { rows: results, items, created } };
}

function serialProblem(tracking: string, quantity: number, serial?: string) {
  return Boolean(serial) && (tracking === "QUANTITY" || quantity > 1);
}
