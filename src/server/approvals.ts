"use server";

import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { requireUser, can, canAny, PERMISSIONS } from "@/lib/authz";
import { toDecimal, one } from "@/lib/decimal";

/**
 * Everything waiting on a decision, in one queue.
 *
 * Approvals are not centralised in the database and deliberately stay that
 * way: quotations, expenses, timesheets, vendor bills and partner rate requests each
 * carry their own status column and their own transition rules, and those
 * rules differ — an expense cannot be approved by the person who claimed it,
 * a quotation can be revised instead of rejected. Rewriting five working
 * mechanisms onto one generic table would risk all of them to gain a shared
 * shape nothing actually needs.
 *
 * What was missing is the view across them. This reads each source, filters to
 * what the reader is allowed to approve, and returns one list — so nobody has
 * to remember which of five screens is holding something up.
 *
 * Each item links to where the decision is actually made, because that screen
 * has the context the approver needs.
 */

export type ApprovalKind =
  | "quotation"
  | "expense"
  | "timesheet"
  | "vendor-bill"
  | "commission"
  | "partner-change";

export interface PendingApproval {
  kind: ApprovalKind;
  id: string;
  reference: string;
  title: string;
  subtitle: string | null;
  /** Money at stake, where the item has an amount. */
  amount: string | null;
  currencyCode: string | null;
  requestedBy: string | null;
  waitingSince: string;
  href: string;
  /** Set when the reader may not decide this one, and why. */
  blockedReason?: string;
}

const formatWeek = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

const daysSince = (iso: string | null | undefined) => {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
};

export async function getPendingApprovals(): Promise<{
  items: PendingApproval[];
  byKind: Record<string, number>;
  totalValue: string;
  oldestDays: number;
}> {
  const me = await requireUser();
  const db = await supabaseServer();

  const seeQuotations = can(me, PERMISSIONS.QUOTATION_APPROVE);
  // This branch is the vendor bill queue, so it follows the authority to
  // approve a payable rather than the one to issue an invoice.
  const seeInvoicing = canAny(me, PERMISSIONS.PAYABLE_APPROVE, PERMISSIONS.INVOICE_APPROVE);
  // Expense claims moved off invoice:approve so that filing one no longer
  // requires the receivables ledger. The queue follows.
  const seeExpenses = can(me, PERMISSIONS.EXPENSE_APPROVE);
  const seeTime = can(me, PERMISSIONS.TIME_APPROVE);
  const seeCommission = can(me, PERMISSIONS.COMMISSION_APPROVE);

  const none = { data: [] as Record<string, unknown>[] };

  const [quotations, expenses, timeLogs, bills, commissions] = await Promise.all([
    seeQuotations
      ? db
          .from("quotation")
          .select(
            "id, quoteNumber, totalAmount, currencyCode, createdAt, approvalRequestedAt, preparedByPartnerId, account ( name ), opportunity ( name )",
          )
          .eq("approvalStatus", "PENDING")
          .is("deletedAt", null)
          .order("approvalRequestedAt")
          .limit(100)
      : none,

    seeExpenses
      ? db
          .from("expense")
          .select(
            "id, expenseNumber, amount, currencyCode, description, createdAt, employeeUserId, category:expense_category ( name ), employee:app_user!expense_employeeUserId_fkey ( fullName )",
          )
          .eq("approvalStatus", "SUBMITTED")
          .is("deletedAt", null)
          .order("createdAt")
          .limit(100)
      : none,

    seeTime
      ? db
          .from("time_log")
          .select(
            "id, hours, workDate, description, createdAt, userId, user:app_user!time_log_userId_fkey ( fullName ), project ( id, name )",
          )
          .eq("approvalStatus", "SUBMITTED")
          .order("workDate")
          .limit(100)
      : none,

    seeInvoicing
      ? db
          .from("vendor_bill")
          .select("id, billNumber, totalAmount, currencyCode, createdAt, vendor:account ( name )")
          .eq("status", "UNDER_REVIEW")
          .is("deletedAt", null)
          .order("createdAt")
          .limit(100)
      : none,

    // A partner asking for a different rate on one deal. Commission itself
    // needs no approval: it follows the deal, and is marked paid by hand.
    seeCommission
      ? db
          .from("partner_commission")
          .select(
            "id, commissionNumber, commissionPercent, requestedPercent, partnerAmount, currencyCode, requestedAt, partner ( displayName ), opportunity ( name )",
          )
          .eq("requestStatus", "PENDING")
          .order("requestedAt")
          .limit(100)
      : none,
  ]);

  type Row = Record<string, any>;
  const items: PendingApproval[] = [];

  // Which partner prepared each quote - only a partner's quote waits for
  // approval (20260928000006). Read with our key: the quotes above are ones the
  // reader may see, and who asked is part of deciding, even for an approver who
  // may not open partner records.
  const preparedIds = [
    ...new Set(((quotations.data ?? []) as Row[]).map((q) => q.preparedByPartnerId).filter(Boolean)),
  ] as string[];
  const partnerNames = new Map<string, string>();
  if (preparedIds.length) {
    const { data: named } = await supabaseAdmin().from("partner").select("id, displayName").in("id", preparedIds);
    for (const p of named ?? []) partnerNames.set(p.id as string, p.displayName as string);
  }

  for (const q of (quotations.data ?? []) as Row[]) {
    const account = one(q.account as never) as Row | null;
    const opportunity = one(q.opportunity as never) as Row | null;
    items.push({
      kind: "quotation",
      id: q.id,
      reference: q.quoteNumber,
      title: opportunity?.name ?? "Quotation",
      subtitle: account?.name ?? null,
      amount: String(q.totalAmount ?? 0),
      currencyCode: q.currencyCode,
      requestedBy: q.preparedByPartnerId ? partnerNames.get(q.preparedByPartnerId) ?? "A partner" : null,
      waitingSince: q.approvalRequestedAt ?? q.createdAt,
      href: `/quotations/${q.id}`,
    });
  }

  for (const e of (expenses.data ?? []) as Row[]) {
    const category = one(e.category as never) as Row | null;
    const employee = one(e.employee as never) as Row | null;
    items.push({
      kind: "expense",
      id: e.id,
      reference: e.expenseNumber,
      title: e.description ?? category?.name ?? "Expense",
      subtitle: category?.name ?? null,
      amount: String(e.amount ?? 0),
      currencyCode: e.currencyCode,
      requestedBy: employee?.fullName ?? null,
      waitingSince: e.createdAt,
      href: `/expenses/${e.id}`,
      // Surfaced rather than hidden: the claimant should see their own item is
      // queued, and understand why the button is not theirs to press.
      blockedReason:
        // An administrator may approve their own (agreed 4 October 2026).
        e.employeeUserId === me.id && !can(me, PERMISSIONS.ADMIN) ? "Your own claim - someone else has to approve it." : undefined,
    });
  }

  // Time is approved a week at a time on its own screen, so the entries are
  // grouped by person and week rather than listed one by one.
  const byUser = new Map<string, { name: string; week: string; hours: number; oldest: string; count: number }>();
  for (const t of (timeLogs.data ?? []) as Row[]) {
    const user = one(t.user as never) as Row | null;
    // Monday of the entry's week: a person's weeks are decided one at a time.
    const day = new Date(`${String(t.workDate).slice(0, 10)}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const week = day.toISOString().slice(0, 10);
    const key = `${t.userId}|${week}`;
    const existing = byUser.get(key);
    const hours = Number(t.hours ?? 0);
    if (existing) {
      existing.hours += hours;
      existing.count += 1;
      if (t.createdAt < existing.oldest) existing.oldest = t.createdAt;
    } else {
      byUser.set(key, {
        name: user?.fullName ?? "Unknown",
        week,
        hours,
        oldest: t.createdAt,
        count: 1,
      });
    }
  }

  for (const [key, group] of byUser) {
    items.push({
      kind: "timesheet",
      id: key,
      reference: `${group.count} entr${group.count === 1 ? "y" : "ies"}`,
      title: `${group.hours.toFixed(2)} hours from ${group.name}`,
      subtitle: `Week of ${formatWeek(group.week)}, awaiting approval`,
      amount: null,
      currencyCode: null,
      requestedBy: group.name,
      waitingSince: group.oldest,
      href: `/timesheets/approvals?week=${group.week}`,
    });
  }

  for (const b of (bills.data ?? []) as Row[]) {
    const vendor = one(b.vendor as never) as Row | null;
    items.push({
      kind: "vendor-bill",
      id: b.id,
      reference: b.billNumber,
      title: vendor?.name ?? "Vendor bill",
      subtitle: "Awaiting approval for payment",
      amount: String(b.totalAmount ?? 0),
      currencyCode: b.currencyCode,
      requestedBy: null,
      waitingSince: b.createdAt,
      href: `/vendor-bills/${b.id}`,
    });
  }

  for (const c of (commissions.data ?? []) as Row[]) {
    const partner = one(c.partner as never) as Row | null;
    const opportunity = one(c.opportunity as never) as Row | null;
    items.push({
      kind: "commission",
      id: c.id,
      reference: c.commissionNumber,
      title: `${partner?.displayName ?? "Partner"} asks for ${Number(c.requestedPercent)}% instead of ${Number(c.commissionPercent)}%`,
      subtitle: opportunity?.name ?? null,
      amount: String(c.partnerAmount ?? 0),
      currencyCode: c.currencyCode,
      requestedBy: null,
      waitingSince: c.requestedAt,
      href: `/commissions/${c.id}`,
    });
  }

  // Oldest first: what has been waiting longest is what is holding someone up.
  if (can(me, PERMISSIONS.ADMIN)) {
    const { data: changes } = await supabaseAdmin().from("partner_change_request")
      .select("id, partnerId, requestedByName, createdAt, changes, partner ( displayName, partnerNumber )").eq("status", "PENDING");
    for (const c of (changes ?? []) as Record<string, any>[]) {
      const partner = one(c.partner as never) as { displayName?: string; partnerNumber?: string } | null;
      items.push({
        kind: "partner-change", id: c.id, reference: partner?.partnerNumber ?? "Partner",
        title: `${partner?.displayName ?? "Partner"} profile change`,
        subtitle: Object.keys(c.changes).length + " field(s)" + (c.changes.bankDetails ? ", including bank details" : ""),
        amount: null, currencyCode: null, requestedBy: c.requestedByName, waitingSince: c.createdAt, href: `/partners/${c.partnerId}`,
      });
    }
  }

  items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));

  const byKind: Record<string, number> = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  const totalValue = items
    .reduce((total, item) => total.plus(toDecimal(item.amount ?? 0)), toDecimal(0))
    .toFixed(2);

  return {
    items,
    byKind,
    totalValue,
    oldestDays: items.length ? daysSince(items[0].waitingSince) : 0,
  };
}
