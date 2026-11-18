"use server";

import { supabaseServer } from "@/lib/supabase";
import { requirePermission, can, PERMISSIONS } from "@/lib/authz";
import { isValidDay } from "@/lib/date-range";

/**
 * Expense analytics: spending over time, split by category or by who paid.
 *
 * Read with the person's own client, so the same rows as the Expenses list:
 * an approver sees everyone's spending, anyone else only their own claims.
 * Totals are PKR; expenses in another currency are counted and reported as
 * left out rather than silently added at a guessed rate.
 */

export type Grain = "day" | "week" | "month";
export type ColorBy = "category" | "payer";

export interface AnalyticsFilters {
  from: string | null;
  to: string | null;
  grain: Grain;
  colorBy: ColorBy;
  categoryIds: string[];
  /** User ids, and "COMPANY" for the company paying directly. */
  payers: string[];
  approval: string[];
  payment: string[];
  search: string | null;
  includeBills: boolean;
}

export interface SeriesInfo { key: string; label: string; total: number; count: number; slotKey: string }
export interface Bucket { start: string; end: string; label: string; total: number; count: number; parts: Record<string, { amount: number; count: number }> }

const COMPANY = "COMPANY";
const BILLS = "BILLS";

function startOf(day: string, grain: Grain): string {
  if (grain === "day") return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  const dow = (d.getUTCDay() + 6) % 7; // Monday first
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function nextStart(start: string, grain: Grain): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (grain === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function minusDay(day: string) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function bucketLabel(start: string, grain: Grain): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (grain === "month") return d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export async function getExpenseAnalytics(f: AnalyticsFilters) {
  const me = await requirePermission(PERMISSIONS.EXPENSE_READ);
  const db = await supabaseServer();
  const approver = can(me, PERMISSIONS.EXPENSE_APPROVE);

  // --- Expenses -------------------------------------------------------------
  let q = db.from("expense")
    .select("id, expenseNumber, expenseDate, amount, currencyCode, categoryId, employeeUserId, reimbursable, approvalStatus, paymentStatus, description, category:expense_category ( name ), employee:app_user!expense_employeeUserId_fkey ( fullName )")
    .is("deletedAt", null)
    .order("expenseDate")
    .limit(10000);
  if (!approver) q = q.eq("employeeUserId", me.id);
  if (f.from && isValidDay(f.from)) q = q.gte("expenseDate", f.from);
  if (f.to && isValidDay(f.to)) q = q.lte("expenseDate", f.to);
  if (f.categoryIds.length) q = q.in("categoryId", f.categoryIds);
  if (f.approval.length) q = q.in("approvalStatus", f.approval);
  else q = q.neq("approvalStatus", "REJECTED");
  if (f.payment.length) q = q.in("paymentStatus", f.payment);
  if (f.search) {
    const s = f.search.replace(/[%,()]/g, " ").trim();
    if (s) q = q.or(`description.ilike.%${s}%,expenseNumber.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(`Could not load expenses: ${error.message}`);

  type Row = { date: string; amount: number; currency: string; categoryKey: string; categoryLabel: string; payerKey: string; payerLabel: string };
  const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  let rows: Row[] = (data ?? []).map((e) => {
    const paidBySomeone = Boolean(e.reimbursable && e.employeeUserId);
    return {
      date: String(e.expenseDate).slice(0, 10),
      amount: Number(e.amount ?? 0),
      currency: e.currencyCode as string,
      categoryKey: (e.categoryId as string) ?? "NONE",
      categoryLabel: (flat(e.category) as { name: string } | null)?.name ?? "Uncategorised",
      payerKey: paidBySomeone ? (e.employeeUserId as string) : COMPANY,
      payerLabel: paidBySomeone ? (flat(e.employee) as { fullName: string } | null)?.fullName ?? "Someone" : "Company paid directly",
    };
  });
  if (f.payers.length) rows = rows.filter((r) => f.payers.includes(r.payerKey));

  // --- Supplier bills, if asked and allowed ------------------------------------
  const canSeeBills = can(me, PERMISSIONS.INVOICE_READ);
  if (f.includeBills && canSeeBills && !f.categoryIds.length && (!f.payers.length || f.payers.includes(COMPANY)) && !f.search) {
    let bq = db.from("vendor_bill").select("billDate, totalAmount, currencyCode, status").is("deletedAt", null).neq("status", "CANCELLED").limit(10000);
    if (f.from && isValidDay(f.from)) bq = bq.gte("billDate", f.from);
    if (f.to && isValidDay(f.to)) bq = bq.lte("billDate", f.to);
    const { data: bills } = await bq;
    rows = rows.concat((bills ?? []).map((b) => ({
      date: String(b.billDate).slice(0, 10), amount: Number(b.totalAmount ?? 0), currency: b.currencyCode as string,
      categoryKey: BILLS, categoryLabel: "Supplier bills", payerKey: COMPANY, payerLabel: "Company paid directly",
    })));
  }

  const excluded = rows.filter((r) => r.currency !== "PKR");
  rows = rows.filter((r) => r.currency === "PKR");

  // --- Buckets ------------------------------------------------------------------
  const firstDay = f.from ?? rows[0]?.date ?? null;
  const lastDay = f.to ?? rows[rows.length - 1]?.date ?? null;
  const buckets: Bucket[] = [];
  if (firstDay && lastDay) {
    let start = startOf(firstDay, f.grain);
    let guard = 0;
    while (start <= lastDay && guard++ < 2000) {
      const next = nextStart(start, f.grain);
      buckets.push({ start, end: minusDay(next), label: bucketLabel(start, f.grain), total: 0, count: 0, parts: {} });
      start = next;
    }
  }
  const index = new Map(buckets.map((b, i) => [b.start, i]));
  const seriesMap = new Map<string, SeriesInfo>();
  for (const r of rows) {
    const b = buckets[index.get(startOf(r.date, f.grain)) ?? -1];
    if (!b) continue;
    const key = f.colorBy === "category" ? r.categoryKey : r.payerKey;
    const label = f.colorBy === "category" ? r.categoryLabel : r.payerLabel;
    b.total += r.amount; b.count += 1;
    const part = (b.parts[key] ??= { amount: 0, count: 0 });
    part.amount += r.amount; part.count += 1;
    const s = seriesMap.get(key) ?? { key, label, total: 0, count: 0, slotKey: key };
    s.total += r.amount; s.count += 1;
    seriesMap.set(key, s);
  }

  // --- Stable colours: the slot follows the entity, never this view's ranking.
  // Every category / payer the reader can filter by is ordered once by name,
  // so filtering one out never repaints the rest.
  const [{ data: allCats }, { data: allPayers }] = await Promise.all([
    db.from("expense_category").select("id, name").order("name"),
    approver
      ? db.from("expense").select("employeeUserId, employee:app_user!expense_employeeUserId_fkey ( fullName )").eq("reimbursable", true).not("employeeUserId", "is", null).is("deletedAt", null).limit(5000)
      : Promise.resolve({ data: [{ employeeUserId: me.id, employee: { fullName: me.fullName } }] }),
  ]);
  const payerOptions = new Map<string, string>();
  for (const e of allPayers ?? []) {
    const name = (flat((e as { employee: unknown }).employee) as { fullName: string } | null)?.fullName;
    if (e.employeeUserId && name) payerOptions.set(e.employeeUserId as string, name);
  }
  const categoryOptions = (allCats ?? []).map((c) => ({ id: c.id as string, name: c.name as string }));
  const palette = f.colorBy === "category"
    ? [...categoryOptions.map((c) => c.id), BILLS, "NONE"]
    : [COMPANY, ...[...payerOptions.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id)];

  const series = [...seriesMap.values()].sort((a, b) => b.total - a.total);
  // Up to 7 named series plus Other: an eighth hue would have to be generated.
  const MAX_NAMED = 7;
  const keepKeys = new Set(series.slice(0, series.length > 8 ? MAX_NAMED : 8).map((s) => s.key));
  if (series.length > 8) {
    const other: SeriesInfo = { key: "OTHER", label: `Other (${series.length - MAX_NAMED})`, total: 0, count: 0, slotKey: "OTHER" };
    for (const s of series.filter((x) => !keepKeys.has(x.key))) { other.total += s.total; other.count += s.count; }
    for (const b of buckets) {
      for (const [k, v] of Object.entries(b.parts)) {
        if (keepKeys.has(k)) continue;
        const o = (b.parts.OTHER ??= { amount: 0, count: 0 });
        o.amount += v.amount; o.count += v.count;
        delete b.parts[k];
      }
    }
    series.splice(MAX_NAMED, series.length, other);
  }
  // Slot = position among every possible entity, taken modulo the 8 hues.
  // Two entities can wrap onto the same hue; the one drawn second moves to the
  // next free hue, so no two series on screen ever share a colour.
  const taken = new Set<number>();
  const slots = new Map<string, number>();
  for (const s of [...series].sort((a, b) => palette.indexOf(a.key) - palette.indexOf(b.key))) {
    if (s.key === "OTHER") continue;
    let slot = Math.max(0, palette.indexOf(s.key)) % 8;
    while (taken.has(slot)) slot = (slot + 1) % 8;
    taken.add(slot);
    slots.set(s.key, slot);
  }
  const slotOf = (key: string) => (key === "OTHER" ? -1 : slots.get(key) ?? 0);

  const total = rows.reduce((t, r) => t + r.amount, 0);
  const periodsWithSpend = buckets.filter((b) => b.total > 0).length;
  return {
    buckets,
    series: series.map((s) => ({ ...s, slot: slotOf(s.key) })),
    total,
    count: rows.length,
    average: buckets.length ? total / buckets.length : 0,
    periodsWithSpend,
    excludedCount: excluded.length,
    excludedCurrencies: [...new Set(excluded.map((r) => r.currency))],
    categoryOptions,
    payerOptions: [{ id: COMPANY, name: "Company paid directly" }, ...[...payerOptions.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))],
    canSeeBills,
    seesEveryone: approver,
  };
}
