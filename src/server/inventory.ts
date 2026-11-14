"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { createRecord } from "@/lib/db";
import { describeInvalid } from "@/lib/form-errors";
import { SEQUENCES } from "@/lib/numbering";
import {
  authorize, authorizeAny, requireUser, can, canAny, PERMISSIONS, AuthorizationError, type SessionUser,
} from "@/lib/authz";
import type { ActionResult } from "./partners";

/**
 * Inventory: everything the company owns, who or where has it, and what paid
 * for it.
 *
 * The money lives in expenses and vendor bills, never here. An asset points at
 * the expense or bill that bought it, and its purchaseCost is its share of that
 * amount, so spending is counted once. Buying something from this screen
 * records the expense first and links it.
 *
 * The tables are service-role only (no row policies), so every function checks
 * asset:read / asset:write itself, or that the reader holds the item.
 */

const db = () => supabaseAdmin();
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

export type Condition = "NEW" | "GOOD" | "NEEDS_REPAIR" | "BROKEN";
export type AssetStatus = "IN_STOCK" | "ASSIGNED" | "IN_REPAIR" | "RETIRED" | "LOST" | "DISPOSED";

const CONDITIONS = ["NEW", "GOOD", "NEEDS_REPAIR", "BROKEN"] as const;
const CLOSED_STATUSES: AssetStatus[] = ["RETIRED", "LOST", "DISPOSED"];

function canReadAll(user: SessionUser) {
  return canAny(user, PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_WRITE);
}

/** Finance users and administrators record purchases already approved. */
function approvesOwnPurchase(user: SessionUser) {
  return can(user, PERMISSIONS.ADMIN) || can(user, PERMISSIONS.EXPENSE_APPROVE);
}

function refresh(assetId?: string) {
  revalidatePath("/inventory");
  revalidatePath("/inventory/mine");
  if (assetId) revalidatePath(`/inventory/${assetId}`);
}

async function audit(assetId: string, fieldName: string, oldValue: string | null, newValue: string | null, actorId: string) {
  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "Asset", entityId: assetId, fieldName, oldValue, newValue,
    changedById: actorId, source: "UI", changedAt: now(),
  });
}

async function event(assetId: string, kind: string, actorId: string, extra: { note?: string | null; quantityChange?: number | null; cost?: number | null; expenseId?: string | null } = {}) {
  await db().from("asset_event").insert({
    assetId, kind, actorId, note: extra.note ?? null, quantityChange: extra.quantityChange ?? null,
    cost: extra.cost ?? null, expenseId: extra.expenseId ?? null,
  });
}

async function nextTag(): Promise<string> {
  const { data, error } = await db().rpc("next_sequence_number", { p_entity_type: SEQUENCES.ASSET });
  if (error) throw new Error(error.message);
  return data as string;
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const uuid = z.preprocess(blank, z.string().uuid().nullable().optional());
const day = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.").nullable().optional());
const money = z.preprocess(blank, z.coerce.number().min(0, "Cannot be negative.").nullable().optional());

function invalid(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: describeInvalid(error), fieldErrors: error.flatten().fieldErrors as Record<string, string[]> };
}

// ---------------------------------------------------------------------------
// Purchase: where the money for an item came from
// ---------------------------------------------------------------------------

/**
 * COMPANY / REIMBURSE record a new expense in the "Asset purchase" category.
 * EXPENSE / BILL link one already in the system. GIFT / EXISTING carry no
 * money record, only an estimated value.
 */
const purchaseSchema = z.object({
  paidHow: z.enum(["COMPANY", "REIMBURSE", "EXPENSE", "BILL", "GIFT", "EXISTING"]),
  purchaseDate: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "When was it bought?")),
  unitCost: z.preprocess(blank, z.coerce.number({ invalid_type_error: "Enter the cost." }).min(0, "Cannot be negative.")),
  currencyCode: z.preprocess(blank, z.string().length(3).default("PKR")),
  supplierName: text(150),
  supplierAccountId: uuid,
  invoiceReference: text(100),
  purchaseDetails: text(2000),
  paidByUserId: uuid,
  expenseId: uuid,
  vendorBillId: uuid,
});
type Purchase = z.infer<typeof purchaseSchema>;

type MoneyLink = { expenseId: string | null; vendorBillId: string | null; currencyCode: string; createdExpenseId: string | null };

/** How much of an expense or bill items already claim. */
async function allocated(kind: "expense" | "bill", id: string): Promise<number> {
  const column = kind === "expense" ? "expenseId" : "vendorBillId";
  const { data: assets } = await db().from("asset").select("purchaseCost").eq(column, id).is("deletedAt", null);
  let total = (assets ?? []).reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0);
  if (kind === "expense") {
    const { data: events } = await db().from("asset_event").select("cost").eq("expenseId", id).eq("kind", "STOCK_IN");
    total += (events ?? []).reduce((t, e) => t + Number(e.cost ?? 0), 0);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Checks the purchase and, for a new purchase, records the expense.
 * Returns the link to store on the item. `total` is what this purchase costs.
 */
async function settlePurchase(
  user: SessionUser,
  p: Purchase,
  total: number,
  description: string,
): Promise<{ ok: true; link: MoneyLink } | { ok: false; error: string; fieldErrors?: Record<string, string[]> }> {
  if (p.purchaseDate > today()) {
    return { ok: false, error: "The purchase date cannot be in the future.", fieldErrors: { purchaseDate: ["Cannot be in the future."] } };
  }

  if (p.paidHow === "GIFT" || p.paidHow === "EXISTING") {
    if (!p.purchaseDetails) {
      return { ok: false, error: "Say where it came from in the purchase details.", fieldErrors: { purchaseDetails: ["Required for a gift or an item we already had."] } };
    }
    return { ok: true, link: { expenseId: null, vendorBillId: null, currencyCode: p.currencyCode, createdExpenseId: null } };
  }

  if (p.paidHow === "COMPANY" || p.paidHow === "REIMBURSE") {
    if (!can(user, PERMISSIONS.EXPENSE_WRITE)) {
      return { ok: false, error: "Recording a purchase also records an expense, and your role cannot file expenses. Ask finance to record it, or link an expense that already exists." };
    }
    if (total <= 0) {
      return { ok: false, error: "A purchase has to cost more than zero.", fieldErrors: { unitCost: ["More than zero for a purchase."] } };
    }
    if (!p.supplierName && !p.supplierAccountId) {
      return { ok: false, error: "Say who it was bought from.", fieldErrors: { supplierName: ["Who sold it?"] } };
    }
    const paidBy = p.paidHow === "REIMBURSE" ? p.paidByUserId ?? user.id : null;

    const { data: category } = await db().from("expense_category").select("id").ilike("name", "asset purchase").maybeSingle();
    if (!category) return { ok: false, error: "The Asset purchase expense category is missing. Add it under Settings and try again." };

    const details = [description, p.supplierName && `from ${p.supplierName}`, p.invoiceReference && `ref ${p.invoiceReference}`]
      .filter(Boolean).join(", ");
    try {
      const created = await createRecord<{ id: string }>(
        "expense",
        {
          categoryId: category.id,
          expenseDate: p.purchaseDate,
          amount: total,
          taxAmount: null,
          currencyCode: p.currencyCode,
          description: `Asset purchase: ${details}${p.purchaseDetails ? `. ${p.purchaseDetails}` : ""}`.slice(0, 2000),
          employeeUserId: paidBy,
          vendorAccountId: p.supplierAccountId ?? null,
          projectId: null,
          billableToCustomer: false,
          reimbursable: p.paidHow === "REIMBURSE",
          approvalStatus: approvesOwnPurchase(user) ? "APPROVED" : "DRAFT",
          paymentStatus: "UNPAID",
        },
        { field: "expenseNumber", sequence: SEQUENCES.EXPENSE },
      );
      revalidatePath("/expenses");
      return { ok: true, link: { expenseId: created.id, vendorBillId: null, currencyCode: p.currencyCode, createdExpenseId: created.id } };
    } catch (err) {
      return { ok: false, error: `The expense could not be recorded: ${err instanceof Error ? err.message : "unknown error"}` };
    }
  }

  // Linking money already recorded.
  if (p.paidHow === "EXPENSE") {
    if (!p.expenseId) return { ok: false, error: "Choose the expense that paid for it.", fieldErrors: { expenseId: ["Choose an expense."] } };
    const { data: expense } = await db().from("expense")
      .select("id, amount, currencyCode, approvalStatus, deletedAt").eq("id", p.expenseId).maybeSingle();
    if (!expense || expense.deletedAt) return { ok: false, error: "That expense no longer exists." };
    if (expense.approvalStatus === "REJECTED") return { ok: false, error: "That expense was rejected, so it did not pay for anything." };
    const room = Number(expense.amount) - (await allocated("expense", expense.id));
    if (total > room + 0.005) {
      return { ok: false, error: `That expense only has ${room.toFixed(2)} ${expense.currencyCode} left to put against items, and these cost ${total.toFixed(2)}.`, fieldErrors: { unitCost: ["More than is left on the expense."] } };
    }
    return { ok: true, link: { expenseId: expense.id, vendorBillId: null, currencyCode: expense.currencyCode, createdExpenseId: null } };
  }

  if (!p.vendorBillId) return { ok: false, error: "Choose the supplier bill that paid for it.", fieldErrors: { vendorBillId: ["Choose a bill."] } };
  const { data: bill } = await db().from("vendor_bill")
    .select("id, totalAmount, currencyCode, status, deletedAt").eq("id", p.vendorBillId).maybeSingle();
  if (!bill || bill.deletedAt) return { ok: false, error: "That bill no longer exists." };
  if (["CANCELLED", "VOID"].includes(bill.status)) return { ok: false, error: "That bill was cancelled." };
  const room = Number(bill.totalAmount) - (await allocated("bill", bill.id));
  if (total > room + 0.005) {
    return { ok: false, error: `That bill only has ${room.toFixed(2)} ${bill.currencyCode} left to put against items, and these cost ${total.toFixed(2)}.`, fieldErrors: { unitCost: ["More than is left on the bill."] } };
  }
  return { ok: true, link: { expenseId: null, vendorBillId: bill.id, currencyCode: bill.currencyCode, createdExpenseId: null } };
}

// ---------------------------------------------------------------------------
// Lists for the forms
// ---------------------------------------------------------------------------

export async function getInventoryOptions() {
  const user = await requireUser();
  if (!canReadAll(user)) throw new AuthorizationError("Missing permission: asset:read");

  const [categories, types, locations, users, vendors, currencies, expenses, bills] = await Promise.all([
    db().from("asset_category").select("id, name, active").order("sortOrder").order("name"),
    db().from("asset_type").select("id, name, tracking, usefulLifeMonths, active, categoryId").order("name"),
    db().from("asset_location").select("id, name, active").order("name"),
    db().from("app_user").select("id, fullName").eq("status", "ACTIVE").is("deletedAt", null)
      .or("userType.is.null,userType.eq.INTERNAL").is("partnerId", null).order("fullName"),
    db().from("account").select("id, name").in("accountType", ["VENDOR", "PARTNER", "OTHER"]).is("deletedAt", null).order("name"),
    db().from("currency").select("code, name").order("code"),
    db().from("expense").select("id, expenseNumber, description, amount, currencyCode, expenseDate, approvalStatus")
      .is("deletedAt", null).neq("approvalStatus", "REJECTED").order("expenseDate", { ascending: false }).limit(300),
    db().from("vendor_bill").select("id, billNumber, totalAmount, currencyCode, billDate, status, vendor:account ( name )")
      .is("deletedAt", null).order("billDate", { ascending: false }).limit(200),
  ]);

  const categoryName = new Map((categories.data ?? []).map((c) => [c.id, c.name as string]));
  return {
    categories: categories.data ?? [],
    types: (types.data ?? []).map((t) => ({ ...t, categoryName: categoryName.get(t.categoryId) ?? "" })),
    locations: locations.data ?? [],
    users: users.data ?? [],
    vendors: vendors.data ?? [],
    currencies: currencies.data?.length ? currencies.data : [{ code: "PKR", name: "Pakistani Rupee" }],
    expenses: (expenses.data ?? []).map((e) => ({
      id: e.id as string,
      label: `${e.expenseNumber} - ${e.expenseDate} - ${Number(e.amount).toLocaleString()} ${e.currencyCode}${e.description ? ` - ${String(e.description).slice(0, 50)}` : ""}`,
    })),
    bills: (bills.data ?? []).filter((b) => !["CANCELLED", "VOID"].includes(b.status as string)).map((b) => {
      const vendor = Array.isArray(b.vendor) ? b.vendor[0] : b.vendor;
      return {
        id: b.id as string,
        label: `${b.billNumber} - ${b.billDate} - ${Number(b.totalAmount).toLocaleString()} ${b.currencyCode}${vendor?.name ? ` - ${vendor.name}` : ""}`,
      };
    }),
    canRecordExpense: can(user, PERMISSIONS.EXPENSE_WRITE),
    approvesPurchase: approvesOwnPurchase(user),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type AssetRow = Record<string, unknown> & {
  id: string; assetTag: string; name: string; tracking: string; quantity: number; status: AssetStatus;
  condition: Condition; purchaseDate: string; purchaseCost: number; currencyCode: string;
  warrantyEndsOn: string | null; licenceExpiresOn: string | null; expenseId: string | null; vendorBillId: string | null;
  acquisition: string; brand: string | null; model: string | null; serialNumber: string | null;
};

export interface AttentionFlag { code: string; label: string; tone: "warning" | "danger" | "info" }

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
}

/** Why an item needs someone to look at it, if it does. */
function attentionFor(
  a: AssetRow,
  usefulLifeMonths: number | null,
  money: { missing: boolean },
  disputed: boolean,
): AttentionFlag[] {
  if (CLOSED_STATUSES.includes(a.status)) return [];
  const flags: AttentionFlag[] = [];
  if (a.warrantyEndsOn) {
    const d = daysUntil(a.warrantyEndsOn);
    if (d >= 0 && d <= 30) flags.push({ code: "warranty", label: `Warranty ends in ${d} day${d === 1 ? "" : "s"}`, tone: "warning" });
  }
  if (a.licenceExpiresOn) {
    const d = daysUntil(a.licenceExpiresOn);
    if (d < 0) flags.push({ code: "licence", label: "Licence expired", tone: "danger" });
    else if (d <= 30) flags.push({ code: "licence", label: `Licence renews in ${d} day${d === 1 ? "" : "s"}`, tone: "warning" });
  }
  if (usefulLifeMonths && addMonths(a.purchaseDate, usefulLifeMonths) < today()) {
    flags.push({ code: "age", label: "Past its useful life", tone: "info" });
  }
  if (a.condition === "BROKEN") flags.push({ code: "broken", label: "Broken", tone: "danger" });
  else if (a.condition === "NEEDS_REPAIR") flags.push({ code: "repair", label: "Needs repair", tone: "warning" });
  if (a.status === "IN_REPAIR") flags.push({ code: "in_repair", label: "In repair", tone: "info" });
  if (money.missing) flags.push({ code: "money", label: "Purchase record missing", tone: "danger" });
  if (disputed) flags.push({ code: "disputed", label: "Holder reported a problem", tone: "danger" });
  return flags;
}

/** Expenses and bills that were deleted, rejected or cancelled after items were linked. */
async function brokenMoneyLinks(rows: AssetRow[]): Promise<Set<string>> {
  const expenseIds = [...new Set(rows.map((r) => r.expenseId).filter(Boolean))] as string[];
  const billIds = [...new Set(rows.map((r) => r.vendorBillId).filter(Boolean))] as string[];
  const bad = new Set<string>();
  if (expenseIds.length) {
    const { data } = await db().from("expense").select("id, deletedAt, approvalStatus").in("id", expenseIds);
    const ok = new Set((data ?? []).filter((e) => !e.deletedAt && e.approvalStatus !== "REJECTED").map((e) => e.id));
    for (const id of expenseIds) if (!ok.has(id)) bad.add(id);
  }
  if (billIds.length) {
    const { data } = await db().from("vendor_bill").select("id, deletedAt, status").in("id", billIds);
    const ok = new Set((data ?? []).filter((b) => !b.deletedAt && !["CANCELLED", "VOID"].includes(b.status)).map((b) => b.id));
    for (const id of billIds) if (!ok.has(id)) bad.add(id);
  }
  return bad;
}

export interface InventoryFilters {
  search?: string;
  categoryId?: string;
  typeId?: string;
  status?: string;
  holderUserId?: string;
  locationId?: string;
  /** Only items on the Needs attention list. */
  attention?: boolean;
}

export async function listAssets(filters: InventoryFilters = {}) {
  const user = await requireUser();
  if (!canReadAll(user)) throw new AuthorizationError("Missing permission: asset:read");

  let query = db().from("asset")
    .select("*, type:asset_type ( id, name, tracking, usefulLifeMonths, categoryId, category:asset_category ( id, name ) ), location:asset_location ( id, name )")
    .is("deletedAt", null)
    .order("assetTag", { ascending: false })
    .limit(1000);
  if (filters.typeId) query = query.eq("typeId", filters.typeId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.search) {
    const s = filters.search.replace(/[%,()]/g, " ").trim();
    if (s) query = query.or(`name.ilike.%${s}%,assetTag.ilike.%${s}%,serialNumber.ilike.%${s}%,brand.ilike.%${s}%,model.ilike.%${s}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Could not load the inventory: ${error.message}`);

  let rows = (data ?? []) as unknown as (AssetRow & {
    type: { id: string; name: string; tracking: string; usefulLifeMonths: number | null; categoryId: string; category: { id: string; name: string } | null } | null;
    location: { id: string; name: string } | null;
  })[];
  if (filters.categoryId) rows = rows.filter((r) => r.type?.categoryId === filters.categoryId);

  const ids = rows.map((r) => r.id);
  const { data: open } = ids.length
    ? await db().from("asset_assignment")
        .select("id, assetId, quantity, acceptStatus, assigneeUserId, locationId, user:app_user!asset_assignment_assigneeUserId_fkey ( id, fullName ), place:asset_location ( id, name )")
        .in("assetId", ids).is("returnedAt", null)
    : { data: [] };
  type OpenRow = NonNullable<typeof open>[number];
  const byAsset = new Map<string, OpenRow[]>();
  for (const a of open ?? []) {
    const list = byAsset.get(a.assetId as string) ?? [];
    list.push(a);
    byAsset.set(a.assetId as string, list);
  }
  const badMoney = await brokenMoneyLinks(rows);

  let result = rows.map((r) => {
    const holders = (byAsset.get(r.id) ?? []).map((h) => {
      const u = Array.isArray(h.user) ? h.user[0] : h.user;
      const p = Array.isArray(h.place) ? h.place[0] : h.place;
      return {
        assignmentId: h.id as string, quantity: h.quantity as number, acceptStatus: h.acceptStatus as string,
        userId: (h.assigneeUserId as string | null) ?? null, locationId: (h.locationId as string | null) ?? null,
        name: (u?.fullName as string | undefined) ?? (p?.name as string | undefined) ?? "Unknown", isPlace: !u,
      };
    });
    const inUse = holders.reduce((t, h) => t + h.quantity, 0);
    const missing = Boolean((r.expenseId && badMoney.has(r.expenseId)) || (r.vendorBillId && badMoney.has(r.vendorBillId)));
    return {
      ...r,
      holders,
      inUse,
      available: Math.max(0, r.quantity - inUse),
      flags: attentionFor(r, r.type?.usefulLifeMonths ?? null, { missing }, holders.some((h) => h.acceptStatus === "DISPUTED")),
    };
  });

  if (filters.holderUserId) result = result.filter((r) => r.holders.some((h) => h.userId === filters.holderUserId));
  if (filters.locationId) result = result.filter((r) => r.location?.id === filters.locationId || r.holders.some((h) => h.locationId === filters.locationId));
  if (filters.attention) result = result.filter((r) => r.flags.length > 0);
  return result;
}

export async function getInventorySummary() {
  const rows = await listAssets();
  const live = rows.filter((r) => !CLOSED_STATUSES.includes(r.status));
  const value = new Map<string, number>();
  for (const r of live) value.set(r.currencyCode, (value.get(r.currencyCode) ?? 0) + Number(r.purchaseCost ?? 0));
  return {
    items: live.reduce((t, r) => t + r.quantity, 0),
    records: live.length,
    value: [...value.entries()].map(([currency, total]) => ({ currency, total })),
    inUse: live.reduce((t, r) => t + r.inUse, 0),
    inStock: live.reduce((t, r) => t + (r.status === "IN_STOCK" || r.status === "ASSIGNED" ? r.available : 0), 0),
    attention: live.filter((r) => r.flags.length > 0).length,
    pending: live.reduce((t, r) => t + r.holders.filter((h) => h.acceptStatus === "PENDING").length, 0),
  };
}

export async function getAsset(id: string) {
  const user = await requireUser();
  const { data: asset } = await db().from("asset")
    .select("*, type:asset_type ( id, name, tracking, usefulLifeMonths, category:asset_category ( id, name ) ), location:asset_location ( id, name ), supplier:account ( id, name ), createdBy:app_user!asset_createdById_fkey ( fullName )")
    .eq("id", id).is("deletedAt", null).maybeSingle();
  if (!asset) return null;

  const { data: assignments } = await db().from("asset_assignment")
    .select("*, user:app_user!asset_assignment_assigneeUserId_fkey ( id, fullName ), place:asset_location ( id, name ), assignedBy:app_user!asset_assignment_assignedById_fkey ( fullName ), returnedBy:app_user!asset_assignment_returnedById_fkey ( fullName )")
    .eq("assetId", id).order("assignedAt", { ascending: false });

  // Someone without the inventory permissions sees an item only while it is
  // theirs, and never what it cost.
  const full = canReadAll(user);
  const mine = (assignments ?? []).some((a) => a.assigneeUserId === user.id && !a.returnedAt);
  if (!full && !mine) return null;

  const { data: events } = await db().from("asset_event")
    .select("*, actor:app_user ( fullName ), expense ( id, expenseNumber )")
    .eq("assetId", id).order("createdAt", { ascending: false }).limit(100);

  let expense: { id: string; expenseNumber: string; amount: number; currencyCode: string; approvalStatus: string; paymentStatus: string; deletedAt: string | null } | null = null;
  let bill: { id: string; billNumber: string; totalAmount: number; currencyCode: string; status: string; deletedAt: string | null } | null = null;
  if (full && asset.expenseId) {
    const { data } = await db().from("expense").select("id, expenseNumber, amount, currencyCode, approvalStatus, paymentStatus, deletedAt").eq("id", asset.expenseId).maybeSingle();
    expense = data;
  }
  if (full && asset.vendorBillId) {
    const { data } = await db().from("vendor_bill").select("id, billNumber, totalAmount, currencyCode, status, deletedAt").eq("id", asset.vendorBillId).maybeSingle();
    bill = data;
  }

  const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  const rows = (assignments ?? []).map((a) => ({
    ...a,
    user: flat(a.user) as { id: string; fullName: string } | null,
    place: flat(a.place) as { id: string; name: string } | null,
    assignedBy: flat(a.assignedBy) as { fullName: string } | null,
    returnedBy: flat(a.returnedBy) as { fullName: string } | null,
  }));
  const open = rows.filter((a) => !a.returnedAt);
  const inUse = open.reduce((t, a) => t + (a.quantity as number), 0);
  const type = flat(asset.type) as { id: string; name: string; tracking: string; usefulLifeMonths: number | null; category: { id: string; name: string } | null } | null;
  const missing = Boolean(
    (asset.expenseId && (!expense || expense.deletedAt || expense.approvalStatus === "REJECTED")) ||
    (asset.vendorBillId && (!bill || bill.deletedAt || ["CANCELLED", "VOID"].includes(bill.status))),
  );
  const stockInCost = (events ?? []).filter((e) => e.kind === "STOCK_IN").reduce((t, e) => t + Number(e.cost ?? 0), 0);

  const base = {
    ...asset,
    type: type ? { ...type, category: flat(type.category) } : null,
    location: flat(asset.location) as { id: string; name: string } | null,
    supplier: flat(asset.supplier) as { id: string; name: string } | null,
    createdBy: flat(asset.createdBy) as { fullName: string } | null,
  } as AssetRow & Record<string, unknown>;

  const result = {
    asset: base,
    assignments: full ? rows : rows.filter((a) => a.assigneeUserId === user.id),
    open: full ? open : open.filter((a) => a.assigneeUserId === user.id),
    inUse,
    available: Math.max(0, (asset.quantity as number) - inUse),
    events: full ? (events ?? []).map((e) => ({ ...e, actor: flat(e.actor) as { fullName: string } | null, expense: flat(e.expense) as { id: string; expenseNumber: string } | null })) : [],
    expense,
    bill,
    totalSpent: Number(asset.purchaseCost) + stockInCost,
    flags: attentionFor(base, type?.usefulLifeMonths ?? null, { missing }, open.some((a) => a.acceptStatus === "DISPUTED")),
    full,
    canWrite: can(user, PERMISSIONS.ASSET_WRITE),
    costLocked: Boolean(
      (expense && !expense.deletedAt && expense.approvalStatus === "APPROVED") ||
      (bill && !bill.deletedAt && bill.status !== "DRAFT"),
    ),
  };

  if (!full) {
    // Prices are not for the holder's eyes.
    for (const k of ["purchaseCost", "supplierName", "supplierAccountId", "invoiceReference", "purchaseDetails", "expenseId", "vendorBillId", "supplier"]) {
      delete (result.asset as Record<string, unknown>)[k];
    }
    result.totalSpent = 0;
  }
  return result;
}

/** Items a person holds now, for My equipment. Never carries cost. */
export async function listMyEquipment() {
  const user = await requireUser();
  const { data, error } = await db().from("asset_assignment")
    .select("id, quantity, assignedAt, acceptStatus, acceptNote, note, conditionOut, assignedBy:app_user!asset_assignment_assignedById_fkey ( fullName ), asset ( id, assetTag, name, brand, model, serialNumber, status, condition, warrantyEndsOn, licenceExpiresOn, deletedAt, type:asset_type ( name ) )")
    .eq("assigneeUserId", user.id).is("returnedAt", null).order("assignedAt", { ascending: false });
  if (error) throw new Error(`Could not load your equipment: ${error.message}`);
  const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  return (data ?? [])
    .map((a) => {
      const asset = flat(a.asset) as (Record<string, unknown> & { deletedAt: string | null; type: unknown }) | null;
      return {
        ...a,
        assignedBy: flat(a.assignedBy) as { fullName: string } | null,
        asset: asset ? { ...asset, type: flat(asset.type as never) as { name: string } | null } : null,
      };
    })
    .filter((a) => a.asset && !a.asset.deletedAt);
}

/** Whether to show My equipment in the menu. Cheap: one indexed count. */
export async function holdsEquipment(): Promise<boolean> {
  const userId = (await requireUser()).id;
  const { count } = await db().from("asset_assignment").select("id", { count: "exact", head: true })
    .eq("assigneeUserId", userId).is("returnedAt", null);
  return (count ?? 0) > 0;
}

/** Items registered against one expense or bill, for the panel on that page. */
export async function listAssetsForPurchase(kind: "expense" | "bill", id: string) {
  const user = await requireUser();
  if (!canReadAll(user)) return null;
  const column = kind === "expense" ? "expenseId" : "vendorBillId";
  const { data: direct } = await db().from("asset").select("id, assetTag, name, quantity, purchaseCost, currencyCode, status")
    .eq(column, id).is("deletedAt", null).order("assetTag");
  const items = (direct ?? []).map((a) => ({ ...a, viaStock: false }));
  if (kind === "expense") {
    const { data: stock } = await db().from("asset_event").select("quantityChange, cost, asset ( id, assetTag, name, currencyCode, status )")
      .eq("expenseId", id).eq("kind", "STOCK_IN");
    for (const s of stock ?? []) {
      const a = (Array.isArray(s.asset) ? s.asset[0] : s.asset) as { id: string; assetTag: string; name: string; currencyCode: string; status: string } | null;
      if (a) items.push({ ...a, quantity: s.quantityChange as number, purchaseCost: s.cost as number, viaStock: true });
    }
  }
  return { items, allocated: await allocated(kind, id), canWrite: can(user, PERMISSIONS.ASSET_WRITE) };
}

// ---------------------------------------------------------------------------
// Adding and editing items
// ---------------------------------------------------------------------------

const assetFields = {
  name: z.preprocess(blank, z.string({ required_error: "Give it a name." }).trim().min(1, "Give it a name.").max(150)),
  typeId: z.preprocess(blank, z.string({ required_error: "Choose what kind of item it is." }).uuid("Choose what kind of item it is.")),
  brand: text(100),
  model: text(100),
  serialNumber: text(120),
  locationId: uuid,
  condition: z.preprocess(blank, z.enum(CONDITIONS).default("NEW")),
  warrantyEndsOn: day,
  licenceExpiresOn: day,
  notes: text(4000),
};

const createSchema = z.object({
  ...assetFields,
  /** Individual items: how many identical ones to add. Counted items: how many in this stock line. */
  count: z.preprocess(blank, z.coerce.number().int("Whole numbers only.").min(1, "At least one.").max(500, "At most 500 at a time.").default(1)),
}).and(purchaseSchema);

export async function createAsset(input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const { data: type } = await db().from("asset_type").select("id, name, tracking, active").eq("id", d.typeId).maybeSingle();
  if (!type) return { ok: false, error: "That item type no longer exists.", fieldErrors: { typeId: ["Choose again."] } };
  const individual = type.tracking === "INDIVIDUAL";
  if (individual && d.serialNumber && d.count > 1) {
    return { ok: false, error: "A serial number belongs to one item. Add them one at a time, or leave the serial number empty and fill it in on each item afterwards.", fieldErrors: { serialNumber: ["Only when adding one."] } };
  }

  const total = Math.round(d.unitCost * d.count * 100) / 100;
  const label = d.count > 1 ? `${d.count} x ${d.name}` : d.name;
  const settled = await settlePurchase(auth.user, d, total, label);
  if (!settled.ok) return settled;
  const link = settled.link;

  const base = {
    name: d.name, typeId: d.typeId, tracking: type.tracking, brand: d.brand ?? null, model: d.model ?? null,
    locationId: d.locationId ?? null, condition: d.condition, status: "IN_STOCK",
    acquisition: d.paidHow === "GIFT" ? "GIFT" : d.paidHow === "EXISTING" ? "EXISTING" : "PURCHASED",
    purchaseDate: d.purchaseDate, currencyCode: link.currencyCode,
    supplierName: d.supplierName ?? null, supplierAccountId: d.supplierAccountId ?? null,
    invoiceReference: d.invoiceReference ?? null, purchaseDetails: d.purchaseDetails ?? null,
    expenseId: link.expenseId, vendorBillId: link.vendorBillId,
    warrantyEndsOn: d.warrantyEndsOn ?? null, licenceExpiresOn: d.licenceExpiresOn ?? null,
    notes: d.notes ?? null, createdById: auth.user.id,
  };

  const created: string[] = [];
  try {
    const rows = individual ? d.count : 1;
    for (let i = 0; i < rows; i++) {
      const { data, error } = await db().from("asset").insert({
        ...base,
        assetTag: await nextTag(),
        serialNumber: individual && d.count === 1 ? d.serialNumber ?? null : null,
        quantity: individual ? 1 : d.count,
        purchaseCost: individual ? d.unitCost : total,
      }).select("id").single();
      if (error) throw new Error(error.message);
      created.push(data.id);
      await event(data.id, "CREATED", auth.user.id, {
        quantityChange: individual ? 1 : d.count,
        note: link.createdExpenseId ? "Purchase recorded as a new expense." : link.expenseId ? "Linked to an existing expense." : link.vendorBillId ? "Linked to a supplier bill." : base.acquisition === "GIFT" ? "Received as a gift." : "Already owned before it was recorded.",
      });
      await audit(data.id, "created", null, base.name, auth.user.id);
    }
  } catch (err) {
    // Leave nothing half-made: the items and the expense recorded for them.
    if (created.length) await db().from("asset").delete().in("id", created);
    if (link.createdExpenseId) await db().from("expense").delete().eq("id", link.createdExpenseId);
    return { ok: false, error: `The item could not be saved: ${err instanceof Error ? err.message : "unknown error"}` };
  }

  refresh();
  if (link.expenseId) revalidatePath(`/expenses/${link.expenseId}`);
  if (link.vendorBillId) revalidatePath(`/vendor-bills/${link.vendorBillId}`);
  // One item opens its page; several go back to the list.
  return { ok: true, data: { id: created.length === 1 ? created[0] : "" } };
}

const updateSchema = z.object({
  ...assetFields,
  purchaseDate: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "When was it bought?")),
  purchaseCost: z.preprocess(blank, z.coerce.number({ invalid_type_error: "Enter the cost." }).min(0)),
  supplierName: text(150),
  supplierAccountId: uuid,
  invoiceReference: text(100),
  purchaseDetails: text(2000),
});

export async function updateAsset(id: string, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const { data: before } = await db().from("asset").select("*").eq("id", id).is("deletedAt", null).maybeSingle();
  if (!before) return { ok: false, error: "That item no longer exists." };

  const { data: type } = await db().from("asset_type").select("tracking").eq("id", d.typeId).maybeSingle();
  if (!type) return { ok: false, error: "That item type no longer exists." };
  if (type.tracking !== before.tracking) {
    return { ok: false, error: "An item counted one by one cannot become a counted stock line, or the other way round. Choose a type tracked the same way.", fieldErrors: { typeId: ["Tracked differently."] } };
  }

  // The cost is a share of the expense or bill. Once that money is approved,
  // the cost changes there, not here, so the two never disagree.
  const costChanged = Number(before.purchaseCost) !== d.purchaseCost;
  if (costChanged && (before.expenseId || before.vendorBillId)) {
    if (before.expenseId) {
      const { data: e } = await db().from("expense").select("amount, approvalStatus, deletedAt").eq("id", before.expenseId).maybeSingle();
      if (e && !e.deletedAt && e.approvalStatus === "APPROVED") {
        return { ok: false, error: "The expense that paid for this is approved, so its cost is fixed. Correct the expense instead.", fieldErrors: { purchaseCost: ["Fixed by the approved expense."] } };
      }
      if (e && !e.deletedAt) {
        const room = Number(e.amount) - ((await allocated("expense", before.expenseId)) - Number(before.purchaseCost));
        if (d.purchaseCost > room + 0.005) return { ok: false, error: `The expense only has ${room.toFixed(2)} left for this item.`, fieldErrors: { purchaseCost: ["More than the expense."] } };
      }
    } else {
      const { data: b } = await db().from("vendor_bill").select("totalAmount, status, deletedAt").eq("id", before.vendorBillId).maybeSingle();
      if (b && !b.deletedAt && b.status !== "DRAFT") {
        return { ok: false, error: "The supplier bill for this is approved, so its cost is fixed. Correct the bill instead.", fieldErrors: { purchaseCost: ["Fixed by the bill."] } };
      }
      if (b && !b.deletedAt) {
        const room = Number(b.totalAmount) - ((await allocated("bill", before.vendorBillId)) - Number(before.purchaseCost));
        if (d.purchaseCost > room + 0.005) return { ok: false, error: `The bill only has ${room.toFixed(2)} left for this item.`, fieldErrors: { purchaseCost: ["More than the bill."] } };
      }
    }
  }
  if (d.purchaseDate > today()) return { ok: false, error: "The purchase date cannot be in the future.", fieldErrors: { purchaseDate: ["Cannot be in the future."] } };

  const next: Record<string, unknown> = {
    name: d.name, typeId: d.typeId, brand: d.brand ?? null, model: d.model ?? null,
    serialNumber: before.tracking === "INDIVIDUAL" ? d.serialNumber ?? null : null,
    locationId: d.locationId ?? null, condition: d.condition,
    warrantyEndsOn: d.warrantyEndsOn ?? null, licenceExpiresOn: d.licenceExpiresOn ?? null, notes: d.notes ?? null,
    purchaseDate: d.purchaseDate, purchaseCost: d.purchaseCost, supplierName: d.supplierName ?? null,
    supplierAccountId: d.supplierAccountId ?? null, invoiceReference: d.invoiceReference ?? null,
    purchaseDetails: d.purchaseDetails ?? null, updatedAt: now(),
  };
  const { error } = await db().from("asset").update(next).eq("id", id);
  if (error) return { ok: false, error: error.message };

  for (const [k, v] of Object.entries(next)) {
    if (k === "updatedAt") continue;
    const was = before[k] == null ? null : String(before[k]);
    const is = v == null ? null : String(v);
    if (was !== is && !(k === "purchaseCost" && Number(was) === Number(is))) await audit(id, k, was, is, auth.user.id);
  }
  refresh(id);
  return { ok: true, data: { id } };
}

// ---------------------------------------------------------------------------
// Giving out and taking back
// ---------------------------------------------------------------------------

/** Keeps the status in step with who holds it. Leaves repair and closed states alone. */
async function syncStatus(assetId: string) {
  const { data: a } = await db().from("asset").select("quantity, status, tracking").eq("id", assetId).maybeSingle();
  if (!a || !["IN_STOCK", "ASSIGNED"].includes(a.status)) return;
  const { data: open } = await db().from("asset_assignment").select("quantity").eq("assetId", assetId).is("returnedAt", null);
  const inUse = (open ?? []).reduce((t, o) => t + (o.quantity as number), 0);
  const status = inUse > 0 && inUse >= a.quantity ? "ASSIGNED" : "IN_STOCK";
  if (status !== a.status) await db().from("asset").update({ status, updatedAt: now() }).eq("id", assetId);
}

const assignSchema = z.object({
  to: z.enum(["USER", "LOCATION"]),
  assigneeUserId: uuid,
  locationId: uuid,
  quantity: z.preprocess(blank, z.coerce.number().int().min(1, "At least one.").default(1)),
  condition: z.preprocess(blank, z.enum(CONDITIONS).nullable().optional()),
  note: text(1000),
});

export async function assignAsset(assetId: string, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const { data: asset } = await db().from("asset").select("id, name, assetTag, quantity, status, tracking, condition").eq("id", assetId).is("deletedAt", null).maybeSingle();
  if (!asset) return { ok: false, error: "That item no longer exists." };
  if (!["IN_STOCK", "ASSIGNED"].includes(asset.status)) {
    return { ok: false, error: `It is ${String(asset.status).toLowerCase().replace("_", " ")}, so it cannot be given out. Put it back in stock first.` };
  }

  let userName: string | null = null;
  if (d.to === "USER") {
    if (!d.assigneeUserId) return { ok: false, error: "Choose who gets it.", fieldErrors: { assigneeUserId: ["Choose a person."] } };
    const { data: u } = await db().from("app_user").select("id, fullName, status, userType, partnerId").eq("id", d.assigneeUserId).maybeSingle();
    if (!u || u.status !== "ACTIVE" || (u.userType && u.userType !== "INTERNAL") || u.partnerId) {
      return { ok: false, error: "Items can only go to active staff.", fieldErrors: { assigneeUserId: ["Not an active staff member."] } };
    }
    userName = u.fullName;
  } else if (!d.locationId) {
    return { ok: false, error: "Choose the place it goes to.", fieldErrors: { locationId: ["Choose a place."] } };
  }

  const quantity = asset.tracking === "INDIVIDUAL" ? 1 : d.quantity;
  const { data: open } = await db().from("asset_assignment").select("quantity").eq("assetId", assetId).is("returnedAt", null);
  const inUse = (open ?? []).reduce((t, o) => t + (o.quantity as number), 0);
  const available = asset.quantity - inUse;
  if (quantity > available) {
    return {
      ok: false,
      error: asset.tracking === "INDIVIDUAL"
        ? "Someone already has it. Take it back first, then give it to the next person."
        : `Only ${available} left to give out.`,
      fieldErrors: { quantity: [`${available} available.`] },
    };
  }

  const { data: row, error } = await db().from("asset_assignment").insert({
    assetId, quantity, assigneeUserId: d.to === "USER" ? d.assigneeUserId : null,
    locationId: d.to === "LOCATION" ? d.locationId : null, assignedById: auth.user.id,
    conditionOut: d.condition ?? asset.condition, note: d.note ?? null,
    // A person confirms they got it; a place does not.
    acceptStatus: d.to === "USER" && d.assigneeUserId !== auth.user.id ? "PENDING" : "ACCEPTED",
    acceptedAt: d.to === "USER" && d.assigneeUserId !== auth.user.id ? null : now(),
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  await syncStatus(assetId);
  await audit(assetId, "assignedTo", null, userName ?? "a location", auth.user.id);

  if (d.to === "USER" && d.assigneeUserId && d.assigneeUserId !== auth.user.id) {
    try {
      await db().rpc("notify_user", {
        p_user: d.assigneeUserId, p_kind: "ASSIGNED",
        p_title: `You have been given ${quantity > 1 ? `${quantity} x ` : ""}${asset.name}`,
        p_body: `${auth.user.fullName} gave you ${asset.assetTag}. Open My equipment and confirm you received it.`,
        p_link: "/inventory/mine", p_entity_type: "Asset", p_entity_id: assetId,
      });
    } catch (err) {
      console.error("Inventory notification not sent:", err);
    }
  }
  refresh(assetId);
  return { ok: true, data: { id: row.id } };
}

const returnSchema = z.object({
  condition: z.preprocess(blank, z.enum(CONDITIONS)),
  note: text(1000),
});

export async function returnAssignment(assignmentId: string, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const { data: a } = await db().from("asset_assignment").select("id, assetId, returnedAt").eq("id", assignmentId).maybeSingle();
  if (!a) return { ok: false, error: "That hand-over no longer exists." };
  if (a.returnedAt) return { ok: false, error: "It has already been returned." };

  const { error } = await db().from("asset_assignment").update({
    returnedAt: now(), returnedById: auth.user.id, conditionIn: parsed.data.condition, returnNote: parsed.data.note ?? null,
  }).eq("id", assignmentId).is("returnedAt", null);
  if (error) return { ok: false, error: error.message };

  // What comes back in worse shape says so on the item.
  const { data: asset } = await db().from("asset").select("condition, tracking").eq("id", a.assetId).maybeSingle();
  if (asset && asset.tracking === "INDIVIDUAL" && asset.condition !== parsed.data.condition) {
    await db().from("asset").update({ condition: parsed.data.condition, updatedAt: now() }).eq("id", a.assetId);
    await audit(a.assetId, "condition", asset.condition, parsed.data.condition, auth.user.id);
  }
  await syncStatus(a.assetId);
  await audit(a.assetId, "returned", null, parsed.data.condition, auth.user.id);
  refresh(a.assetId);
  return { ok: true, data: { id: assignmentId } };
}

/** The holder confirms they received it, or says something is wrong. */
export async function respondToAssignment(assignmentId: string, accept: boolean, note?: string | null): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const { data: a } = await db().from("asset_assignment").select("id, assetId, assigneeUserId, returnedAt, acceptStatus, assignedById").eq("id", assignmentId).maybeSingle();
  if (!a || a.assigneeUserId !== auth.user.id || a.returnedAt) return { ok: false, error: "That item is not with you." };
  if (!accept && !note?.trim()) return { ok: false, error: "Say what is wrong, so whoever gave it to you can sort it out." };

  const { error } = await db().from("asset_assignment").update({
    acceptStatus: accept ? "ACCEPTED" : "DISPUTED", acceptedAt: accept ? now() : null, acceptNote: note?.trim() || null,
  }).eq("id", assignmentId);
  if (error) return { ok: false, error: error.message };

  await audit(a.assetId, "receipt", a.acceptStatus, accept ? "ACCEPTED" : "DISPUTED", auth.user.id);
  if (!accept && a.assignedById) {
    try {
      const { data: asset } = await db().from("asset").select("assetTag, name").eq("id", a.assetId).maybeSingle();
      await db().rpc("notify_user", {
        p_user: a.assignedById, p_kind: "ASSIGNED",
        p_title: `${auth.user.fullName} reported a problem with ${asset?.assetTag ?? "an item"}`,
        p_body: note?.trim() ?? "", p_link: `/inventory/${a.assetId}`, p_entity_type: "Asset", p_entity_id: a.assetId,
      });
    } catch (err) {
      console.error("Inventory notification not sent:", err);
    }
  }
  refresh(a.assetId);
  return { ok: true, data: { id: assignmentId } };
}

// ---------------------------------------------------------------------------
// Status, repairs and stock
// ---------------------------------------------------------------------------

const statusSchema = z.object({
  status: z.enum(["IN_STOCK", "IN_REPAIR", "RETIRED", "LOST", "DISPOSED"]),
  condition: z.preprocess(blank, z.enum(CONDITIONS).nullable().optional()),
  note: text(1000),
});

export async function setAssetStatus(assetId: string, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const { data: asset } = await db().from("asset").select("status, condition").eq("id", assetId).is("deletedAt", null).maybeSingle();
  if (!asset) return { ok: false, error: "That item no longer exists." };
  if (asset.status === d.status && !d.condition) return { ok: false, error: "It is already in that state." };
  if (d.status !== "IN_STOCK" && !d.note) {
    return { ok: false, error: "Add a short note saying what happened.", fieldErrors: { note: ["Required."] } };
  }

  // Leaving use takes it back from whoever has it, so nobody holds a retired item.
  if (d.status !== "IN_STOCK") {
    await db().from("asset_assignment").update({
      returnedAt: now(), returnedById: auth.user.id, conditionIn: d.condition ?? asset.condition,
      returnNote: `Taken back: ${d.status.toLowerCase().replace("_", " ")}`,
    }).eq("assetId", assetId).is("returnedAt", null);
  }
  const { error } = await db().from("asset").update({
    status: d.status, condition: d.condition ?? asset.condition, updatedAt: now(),
  }).eq("id", assetId);
  if (error) return { ok: false, error: error.message };

  await event(assetId, d.status === "IN_REPAIR" ? "REPAIR" : "STATUS", auth.user.id, { note: `${d.status.replace("_", " ").toLowerCase()}${d.note ? `: ${d.note}` : ""}` });
  await audit(assetId, "status", asset.status, d.status, auth.user.id);
  if (d.status === "IN_STOCK") await syncStatus(assetId);
  refresh(assetId);
  return { ok: true, data: { id: assetId } };
}

const stockSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  count: z.preprocess(blank, z.coerce.number().int("Whole numbers only.").min(1, "At least one.").max(10000)),
  note: text(1000),
}).and(purchaseSchema.partial({ purchaseDate: true, unitCost: true, paidHow: true }));

/** More of a counted item bought, or some used up, broken or thrown away. */
export async function adjustStock(assetId: string, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = stockSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const { data: asset } = await db().from("asset").select("id, name, quantity, tracking, currencyCode").eq("id", assetId).is("deletedAt", null).maybeSingle();
  if (!asset) return { ok: false, error: "That item no longer exists." };
  if (asset.tracking !== "QUANTITY") return { ok: false, error: "Stock is only counted for items tracked by quantity. Add another item instead." };

  if (d.direction === "OUT") {
    if (!d.note) return { ok: false, error: "Say why they are gone (used, broken, thrown away).", fieldErrors: { note: ["Required."] } };
    const { data: open } = await db().from("asset_assignment").select("quantity").eq("assetId", assetId).is("returnedAt", null);
    const inUse = (open ?? []).reduce((t, o) => t + (o.quantity as number), 0);
    if (d.count > asset.quantity - inUse) {
      return { ok: false, error: `Only ${asset.quantity - inUse} are in stock. Take items back from people or places first.`, fieldErrors: { count: ["More than in stock."] } };
    }
    await db().from("asset").update({ quantity: asset.quantity - d.count, updatedAt: now() }).eq("id", assetId);
    await event(assetId, "STOCK_OUT", auth.user.id, { quantityChange: -d.count, note: d.note });
    await audit(assetId, "quantity", String(asset.quantity), String(asset.quantity - d.count), auth.user.id);
    await syncStatus(assetId);
    refresh(assetId);
    return { ok: true, data: { id: assetId } };
  }

  const p = purchaseSchema.safeParse({ ...d, paidHow: d.paidHow ?? "COMPANY", purchaseDate: d.purchaseDate ?? today(), currencyCode: d.currencyCode ?? asset.currencyCode });
  if (!p.success) return invalid(p.error);
  const total = Math.round(p.data.unitCost * d.count * 100) / 100;
  const settled = await settlePurchase(auth.user, p.data, total, `${d.count} x ${asset.name} (more stock)`);
  if (!settled.ok) return settled;

  await db().from("asset").update({ quantity: asset.quantity + d.count, updatedAt: now() }).eq("id", assetId);
  await event(assetId, "STOCK_IN", auth.user.id, {
    quantityChange: d.count, cost: total, expenseId: settled.link.expenseId,
    note: [d.note, p.data.supplierName && `from ${p.data.supplierName}`].filter(Boolean).join(", ") || null,
  });
  await audit(assetId, "quantity", String(asset.quantity), String(asset.quantity + d.count), auth.user.id);
  await syncStatus(assetId);
  refresh(assetId);
  if (settled.link.expenseId) revalidatePath(`/expenses/${settled.link.expenseId}`);
  return { ok: true, data: { id: assetId } };
}

export async function addAssetNote(assetId: string, note: string): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  if (!note.trim()) return { ok: false, error: "Write the note first." };
  await event(assetId, "NOTE", auth.user.id, { note: note.trim().slice(0, 2000) });
  refresh(assetId);
  return { ok: true, data: { id: assetId } };
}

// ---------------------------------------------------------------------------
// The lists behind the dropdowns
// ---------------------------------------------------------------------------

const typeSchema = z.object({
  name: z.preprocess(blank, z.string({ required_error: "Give it a name." }).trim().min(1).max(80)),
  categoryId: z.preprocess(blank, z.string({ required_error: "Choose a category." }).uuid("Choose a category.")),
  tracking: z.enum(["INDIVIDUAL", "QUANTITY"]),
  usefulLifeMonths: z.preprocess(blank, z.coerce.number().int().min(1).max(600).nullable().optional()),
});

export async function createAssetType(input: Record<string, unknown>): Promise<ActionResult<{ id: string; name: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = typeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { data: clash } = await db().from("asset_type").select("id, name, active").ilike("name", parsed.data.name).maybeSingle();
  if (clash) {
    if (!clash.active) {
      await db().from("asset_type").update({ active: true, updatedAt: now() }).eq("id", clash.id);
      refresh();
      return { ok: true, data: { id: clash.id, name: clash.name } };
    }
    return { ok: false, error: `"${clash.name}" is already on the list.`, fieldErrors: { name: ["Already exists."] } };
  }
  const { data, error } = await db().from("asset_type").insert({ ...parsed.data, usefulLifeMonths: parsed.data.usefulLifeMonths ?? null }).select("id, name").single();
  if (error) return { ok: false, error: error.message };
  refresh();
  revalidatePath("/inventory/settings");
  return { ok: true, data };
}

export async function setAssetTypeActive(id: string, active: boolean): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const { error } = await db().from("asset_type").update({ active, updatedAt: now() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory/settings");
  return { ok: true, data: { id } };
}

const namedSchema = z.object({ name: z.preprocess(blank, z.string({ required_error: "Give it a name." }).trim().min(1).max(100)) });

export async function createAssetLocation(input: Record<string, unknown>): Promise<ActionResult<{ id: string; name: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = namedSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { data: clash } = await db().from("asset_location").select("id, name, active").ilike("name", parsed.data.name).maybeSingle();
  if (clash) {
    if (!clash.active) await db().from("asset_location").update({ active: true, updatedAt: now() }).eq("id", clash.id);
    else return { ok: false, error: `"${clash.name}" is already on the list.`, fieldErrors: { name: ["Already exists."] } };
    revalidatePath("/inventory/settings");
    return { ok: true, data: { id: clash.id, name: clash.name } };
  }
  const { data, error } = await db().from("asset_location").insert({ name: parsed.data.name }).select("id, name").single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory/settings");
  return { ok: true, data };
}

export async function setAssetLocationActive(id: string, active: boolean): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const { error } = await db().from("asset_location").update({ active, updatedAt: now() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory/settings");
  return { ok: true, data: { id } };
}

export async function createAssetCategory(input: Record<string, unknown>): Promise<ActionResult<{ id: string; name: string }>> {
  const auth = await authorizeAny(PERMISSIONS.ASSET_WRITE);
  if (!auth.ok) return auth;
  const parsed = namedSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { data: clash } = await db().from("asset_category").select("id").ilike("name", parsed.data.name).maybeSingle();
  if (clash) return { ok: false, error: "That category is already on the list.", fieldErrors: { name: ["Already exists."] } };
  const { data, error } = await db().from("asset_category").insert({ name: parsed.data.name, sortOrder: 50 }).select("id, name").single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/inventory/settings");
  return { ok: true, data };
}
