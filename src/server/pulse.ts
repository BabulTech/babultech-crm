"use server";

import { supabaseServer } from "@/lib/supabase";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { toDecimal } from "@/lib/decimal";
import { labelAuditRows } from "@/lib/audit-labels";

/**
 * Movement, as opposed to position.
 *
 * The dashboard already answers "what are the numbers". It could not answer
 * "which way are they going", which is the question anyone actually opens a
 * dashboard with. A single figure of 4.2M in pipeline is unreadable without
 * knowing whether last week was 3.1M or 5.8M.
 *
 * Everything here is bucketed by day and returned as a plain series, so the
 * client can draw it without knowing anything about the schema. RLS applies as
 * everywhere else — a rep's trend is their own deals, not the company's.
 */

const CLOSED_STAGES = '("CLOSED_WON","CLOSED_LOST")';

export interface Series {
  /** ISO date (yyyy-mm-dd) of each bucket, oldest first. */
  days: string[];
  /** One value per day, same order. */
  values: number[];
}

export interface Pulse {
  /** Deals created per day over the window. */
  dealsCreated: Series;
  /** Value won per day over the window. */
  wonValue: Series;
  /** Cash collected per day over the window. */
  collected: Series;
  /** Cases opened per day over the window. */
  casesOpened: Series;
  /** Percentage change of the last 7 days against the 7 before them. */
  deltas: {
    dealsCreated: number | null;
    wonValue: number | null;
    collected: number | null;
    casesOpened: number | null;
  };
  windowDays: number;
}

/** Midnight-anchored ISO dates for the last `days` days, oldest first. */
function dayKeys(days: number): string[] {
  const out: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Fold rows into one bucket per day.
 *
 * `column` null means "count the rows"; otherwise the column is summed. Rows
 * whose date falls outside the window are dropped rather than clamped to an
 * edge, which would put a spike on the first bar that never happened.
 */
function bucket(
  rows: Record<string, unknown>[],
  dateField: string,
  days: string[],
  column: string | null,
): Series {
  const index = new Map(days.map((d, i) => [d, i]));
  const values = new Array<number>(days.length).fill(0);

  for (const row of rows) {
    const raw = row[dateField];
    if (!raw) continue;
    const key = String(raw).slice(0, 10);
    const at = index.get(key);
    if (at === undefined) continue;
    values[at] += column ? Number(toDecimal(row[column])) : 1;
  }

  return { days, values };
}

/**
 * Change of the trailing week against the week before it.
 *
 * Null rather than zero when the earlier week was empty: "up 0%" and "there is
 * nothing to compare against" are different statements, and rendering the
 * second as the first invents a trend.
 */
function delta(series: Series): number | null {
  const v = series.values;
  if (v.length < 14) return null;
  const recent = v.slice(-7).reduce((a, b) => a + b, 0);
  const prior = v.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (prior === 0) return recent === 0 ? null : 100;
  return ((recent - prior) / prior) * 100;
}

export async function getPulse(windowDays = 30): Promise<Pulse> {
  const me = await requireUser();
  const db = await supabaseServer();

  const days = dayKeys(windowDays);
  const from = days[0];
  // Timestamp columns need the full instant, date columns only the date part.
  const fromInstant = `${from}T00:00:00.000Z`;

  const seeSales = can(me, PERMISSIONS.OPPORTUNITY_READ);
  const seeFinance = can(me, PERMISSIONS.INVOICE_READ);
  const seeCases = can(me, PERMISSIONS.CASE_READ);

  const empty = { data: [] as Record<string, unknown>[] };

  const [created, won, collected, cases] = await Promise.all([
    seeSales
      ? db.from("opportunity").select("createdAt")
          .is("deletedAt", null).gte("createdAt", fromInstant)
      : empty,
    seeSales
      ? db.from("opportunity").select("actualCloseDate, amount")
          .is("deletedAt", null).eq("stage", "CLOSED_WON").gte("actualCloseDate", from)
      : empty,
    seeFinance
      ? db.from("payment").select("paymentDate, amount")
          .is("deletedAt", null).eq("status", "CLEARED").gte("paymentDate", from)
      : empty,
    seeCases
      ? db.from("support_case").select("createdAt")
          .is("deletedAt", null).gte("createdAt", fromInstant)
      : empty,
  ]);

  const dealsCreated = bucket((created.data ?? []) as Record<string, unknown>[], "createdAt", days, null);
  const wonValue = bucket((won.data ?? []) as Record<string, unknown>[], "actualCloseDate", days, "amount");
  const collectedSeries = bucket((collected.data ?? []) as Record<string, unknown>[], "paymentDate", days, "amount");
  const casesOpened = bucket((cases.data ?? []) as Record<string, unknown>[], "createdAt", days, null);

  return {
    dealsCreated,
    wonValue,
    collected: collectedSeries,
    casesOpened,
    deltas: {
      dealsCreated: delta(dealsCreated),
      wonValue: delta(wonValue),
      collected: delta(collectedSeries),
      casesOpened: delta(casesOpened),
    },
    windowDays,
  };
}

export interface FeedItem {
  id: string;
  at: string;
  entityType: string;
  entityId: string;
  /** Which record: "Acme Ltd", "INV-2026-0012". Null when unknown. */
  recordName: string | null;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string | null;
}

/**
 * The most recent changes anyone made, as a flat stream.
 *
 * Reads `audit_history` rather than polling each table: it is already the one
 * place every write lands, it carries who and what changed, and RLS on it
 * matches the records it describes.
 */
/**
 * Which audited entity types a reader may see, keyed by the permission that
 * governs the module the record belongs to.
 *
 * Mirrors app_can_read_audit() in
 * supabase/migrations/20260830000001_audit_history_rls.sql. RLS is the real
 * boundary — this list only keeps the query from asking for rows it will not be
 * given, and makes the intent legible here rather than only in SQL. If the two
 * disagree, the database wins and the stream quietly loses rows: keep them
 * together.
 */
const AUDIT_ENTITY_PERMISSIONS: Record<string, string> = {
  Lead: "lead:read",
  Campaign: "lead:read",
  Account: "account:read",
  Contact: "account:read",
  Opportunity: "opportunity:read",
  Quotation: "quotation:read",
  Contract: "contract:read",
  Product: "opportunity:read",
  Partner: "partner:read",
  Commission: "commission:read",
  Case: "case:read",
  SupportCase: "case:read",
  Project: "project:read",
  Task: "project:read",
  ProjectTask: "project:read",
  TimeLog: "project:read",
  Activity: "lead:read",
  PartnerCommission: "commission:read",
  StaffProfile: "admin:*",
  EmploymentContract: "admin:*",
  Timesheet: "project:read",
  Invoice: "invoice:read",
  Payment: "invoice:read",
  VendorBill: "invoice:read",
  Expense: "expense:read",
  // Who was deactivated and who was given which role is administration's
  // business, and the first thing worth reading if you should not be here.
  User: "admin:*",
};

/** The audited entity types this user may see, for the panel and its socket. */
export async function getVisibleAuditTypes(): Promise<string[]> {
  const me = await requireUser();
  return Object.entries(AUDIT_ENTITY_PERMISSIONS)
    .filter(([, permission]) => can(me, permission))
    .map(([entityType]) => entityType);
}

export async function getRecentChanges(limit = 25, onlyId?: string): Promise<FeedItem[]> {
  const me = await requireUser();
  const db = await supabaseServer();

  const visibleTypes = await getVisibleAuditTypes();

  // Nothing to watch: a reader with no module read permission at all. Returning
  // early also avoids an `in ()` with an empty list, which PostgREST rejects.
  if (visibleTypes.length === 0) return [];

  let query = db
    .from("audit_history")
    .select("id, changedAt, entityType, entityId, fieldName, oldValue, newValue, changedBy:app_user ( fullName )")
    .in("entityType", visibleTypes);
  if (onlyId) query = query.eq("id", onlyId);
  const { data } = await query
    .order("changedAt", { ascending: false })
    // Over-fetched because the ownership pass below removes rows: asking for
    // exactly `limit` would return a short list whenever any of them belong to
    // someone else.
    .limit(limit * 4);

  // Entity-type access is not the same as row access.
  //
  // Holding expense:read lets a consultant open the expense module, but the
  // module itself only shows them their own claims — so an audit feed of
  // "Expense approvalStatus SUBMITTED -> APPROVED" for the whole company hands
  // them, through the side door, exactly the activity the list screen scopes
  // away. Claims they did not file are filtered out here, matching
  // listExpenses().
  //
  // Only expenses need this today: every other audited type is either already
  // company-wide within its module (invoices, products) or gated by a
  // permission that implies the wider view.
  const rows = (data ?? []) as Record<string, any>[];
  const expenseRows = rows.filter((r) => r.entityType === "Expense");

  let visibleExpenseIds: Set<string> | null = null;
  if (expenseRows.length > 0 && !can(me, PERMISSIONS.EXPENSE_APPROVE)) {
    const { data: mine } = await db
      .from("expense")
      .select("id")
      .eq("employeeUserId", me.id)
      .in("id", [...new Set(expenseRows.map((r) => String(r.entityId)))]);
    visibleExpenseIds = new Set((mine ?? []).map((e) => String(e.id)));
  }

  const shown = rows
    .filter(
      (r) =>
        r.entityType !== "Expense" ||
        visibleExpenseIds === null ||
        visibleExpenseIds.has(String(r.entityId)),
    )
    .slice(0, limit);

  // Names rather than ids: the record each row is about, and any person or
  // record a value points at.
  const labelled = await labelAuditRows(shown, { recordNames: true });

  return labelled.map((r) => ({
    id: String(r.id),
    at: String(r.changedAt),
    entityType: String(r.entityType),
    entityId: String(r.entityId),
    recordName: r.recordName,
    fieldName: String(r.fieldName),
    oldValue: r.oldValue,
    newValue: r.newValue,
    // PostgREST returns an embedded to-one as an object or a one-element
    // array depending on how it inferred the relationship.
    actor:
      (Array.isArray(r.changedBy) ? r.changedBy[0]?.fullName : r.changedBy?.fullName) ?? null,
  }));
}

/**
 * One row that just arrived over the socket, with names filled in. Read
 * again through RLS, so a row the reader may not see comes back null.
 */
export async function describeChange(id: string): Promise<FeedItem | null> {
  return (await getRecentChanges(1, id))[0] ?? null;
}
