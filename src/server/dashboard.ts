"use server";

import { withRateSnapshots } from "@/lib/rate-snapshots";
import { filterDeliveryData, type DeliveryFilters } from "@/lib/delivery-filters";
import { supabaseServer } from "@/lib/supabase";
import { requireUser, can, requirePermission, PERMISSIONS } from "@/lib/authz";
import { toDecimal, one } from "@/lib/decimal";
import {
  resolveRange, previousRange, rangeDays, workingDays, withinRange,
  type DateRange,
} from "@/lib/date-range";

/**
 * Live figures for the dashboard.
 *
 * Every number is a HEAD count or a narrow select rather than a list read, so
 * the whole thing costs a few dozen cheap queries instead of pulling thousands
 * of rows in to length them. They all run in parallel.
 *
 * What each user sees is what RLS lets them see — an OWN-scope rep's "open
 * deals" is their own, not the company's — so these totals agree with the list
 * screens the reader can actually open.
 */

const OPEN_CASE_STATUSES = '("CLOSED","CANCELLED","RESOLVED")';
const CLOSED_STAGES = '("CLOSED_WON","CLOSED_LOST")';

export interface ModuleSummary {
  /**
   * Which modules the reader is allowed to see at all.
   *
   * A permission they lack produces zeros, and a row of confident zeros reads
   * as "nothing is happening" rather than "this is not yours" — so the page
   * hides those cards instead of showing them empty.
   */
  visible: {
    sales: boolean;
    finance: boolean;
    delivery: boolean;
    service: boolean;
    partners: boolean;
  };
  sales: {
    openDeals: number;
    openValue: string;
    wonThisMonth: number;
    wonValueThisMonth: string;
    newLeads: number;
    leadsToFollowUp: number;
    quotesAwaitingReply: number;
    quoteValueOut: string;
  };
  delivery: {
    activeProjects: number;
    atRiskProjects: number;
    milestonesDueSoon: number;
    overdueTasks: number;
    hoursAwaitingApproval: string;
  };
  finance: {
    outstanding: string;
    overdue: string;
    overdueCount: number;
    collectedThisMonth: string;
    unallocatedPayments: string;
    draftInvoices: number;
  };
  service: {
    openCases: number;
    criticalCases: number;
    breachedSla: number;
    unassignedCases: number;
  };
  partners: {
    activePartners: number;
    commissionPayable: string;
    commissionPendingApproval: number;
    agreementsExpiringSoon: number;
  };
}

/** Count rows matching a filter without transferring any of them. */
async function countRows(
  build: (q: ReturnType<Awaited<ReturnType<typeof supabaseServer>>["from"]>) => unknown,
  table: string,
): Promise<number> {
  const db = await supabaseServer();
  const query = build(db.from(table)) as { count: number | null };
  const { count } = (await query) as unknown as { count: number | null };
  return count ?? 0;
}

/** Sum one numeric column across the rows a filter selects. */
async function sumColumn(
  table: string,
  column: string,
  refine: (q: any) => any = (q) => q,
): Promise<string> {
  const db = await supabaseServer();
  const { data } = await refine(db.from(table).select(column).is("deletedAt", null));
  return ((data ?? []) as Record<string, unknown>[])
    .reduce((total, row) => total.plus(toDecimal(row[column])), toDecimal(0))
    .toFixed(2);
}

const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

const daysFromNow = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const today = () => new Date().toISOString().slice(0, 10);

export async function getModuleSummary(): Promise<ModuleSummary> {
  const me = await requireUser();
  const db = await supabaseServer();

  // Permission gates return zeros rather than throwing: a Finance user's
  // dashboard should show finance and simply omit delivery, not fail to load.
  const seeSales = can(me, PERMISSIONS.OPPORTUNITY_READ);
  const seeFinance = can(me, PERMISSIONS.INVOICE_READ);
  const seeCases = can(me, PERMISSIONS.CASE_READ);
  const seeProjects = can(me, PERMISSIONS.PROJECT_READ);
  const seePartners = can(me, PERMISSIONS.PARTNER_READ);

  const monthStart = startOfMonth();
  const now = today();
  const soon = daysFromNow(14);
  const agreementHorizon = daysFromNow(60);

  const visible = { sales: seeSales, finance: seeFinance, delivery: seeProjects, service: seeCases, partners: seePartners };

  // One round trip: app_dashboard_summary (20261023000000) computes every
  // figure below in a single statement, under the reader's own row security.
  // Until that migration is applied the call fails, and the separate queries
  // further down still answer.
  const { data: summary, error: summaryError } = await db.rpc("app_dashboard_summary", {
    p_see_sales: seeSales,
    p_see_projects: seeProjects,
    p_see_finance: seeFinance,
    p_see_cases: seeCases,
    p_see_partners: seePartners,
    p_month_start: monthStart,
    p_today: now,
    p_soon: soon,
    p_agreement_horizon: agreementHorizon,
  });
  // TEMPORARY: `source` tells the ?timing=1 readout which path answered.
  if (!summaryError && summary) return { ...fromSummaryRow(summary, visible), source: "rpc" } as ModuleSummary;

  const nil = { count: null } as const;
  const skip = async () => nil;

  const [
    openDeals, openValueRows, wonThisMonth, wonValueRows,
    newLeads, leadsToFollowUp, quotesOut, quoteValueRows,
    activeProjects, atRiskProjects, milestonesDue, overdueTasks, hoursPending,
    outstandingRows, overdueRows, collectedRows, unallocatedRows, draftInvoices,
    openCases, criticalCases, breachedSla, unassignedCases,
    activePartners, payableRows, pendingApproval, expiringAgreements,
  ] = await Promise.all([
    // ---- sales
    seeSales
      ? db.from("opportunity").select("id", { count: "exact", head: true })
          .is("deletedAt", null).not("stage", "in", CLOSED_STAGES)
      : skip(),
    seeSales
      ? db.from("opportunity").select("amount").is("deletedAt", null).not("stage", "in", CLOSED_STAGES)
      : { data: [] },
    seeSales
      ? db.from("opportunity").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("stage", "CLOSED_WON").gte("actualCloseDate", monthStart)
      : skip(),
    seeSales
      ? db.from("opportunity").select("amount").is("deletedAt", null)
          .eq("stage", "CLOSED_WON").gte("actualCloseDate", monthStart)
      : { data: [] },
    db.from("lead").select("id", { count: "exact", head: true })
      .is("deletedAt", null).in("status", ["NEW", "ASSIGNED"]),
    db.from("lead").select("id", { count: "exact", head: true })
      .is("deletedAt", null).is("convertedAt", null).lte("nextFollowUpAt", new Date().toISOString()),
    seeSales
      ? db.from("quotation").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("status", "SENT")
      : skip(),
    seeSales
      ? db.from("quotation").select("totalAmount").is("deletedAt", null).eq("status", "SENT")
      : { data: [] },

    // ---- delivery
    seeProjects
      ? db.from("project").select("id", { count: "exact", head: true })
          .is("deletedAt", null).in("status", ["ACTIVE", "PLANNING"])
      : skip(),
    seeProjects
      ? db.from("project").select("id", { count: "exact", head: true })
          .is("deletedAt", null).or("status.eq.AT_RISK,health.eq.RED")
      : skip(),
    seeProjects
      ? db.from("milestone").select("id", { count: "exact", head: true })
          .neq("status", "COMPLETED").lte("dueDate", soon)
      : skip(),
    seeProjects
      ? db.from("project_task").select("id", { count: "exact", head: true })
          .not("status", "in", '("COMPLETED","CANCELLED")').lt("dueDate", now)
      : skip(),
    seeProjects
      ? db.from("time_log").select("hours").eq("approvalStatus", "SUBMITTED")
      : { data: [] },

    // ---- finance
    seeFinance
      ? db.from("invoice").select("outstandingAmount").is("deletedAt", null)
          .not("status", "in", '("PAID","CANCELLED","WRITTEN_OFF","DRAFT")')
      : { data: [] },
    seeFinance
      ? db.from("invoice").select("outstandingAmount").is("deletedAt", null)
          .not("status", "in", '("PAID","CANCELLED","WRITTEN_OFF","DRAFT")').lt("dueDate", now)
      : { data: [] },
    seeFinance
      ? db.from("payment").select("amount").is("deletedAt", null)
          .eq("status", "CLEARED").gte("paymentDate", monthStart)
      : { data: [] },
    seeFinance
      ? db.from("payment").select("unallocatedAmount").is("deletedAt", null).gt("unallocatedAmount", 0)
      : { data: [] },
    seeFinance
      ? db.from("invoice").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("status", "DRAFT")
      : skip(),

    // ---- service
    seeCases
      ? db.from("support_case").select("id", { count: "exact", head: true })
          .is("deletedAt", null).not("status", "in", OPEN_CASE_STATUSES)
      : skip(),
    seeCases
      ? db.from("support_case").select("id", { count: "exact", head: true })
          .is("deletedAt", null).not("status", "in", OPEN_CASE_STATUSES).eq("priority", "CRITICAL")
      : skip(),
    seeCases
      ? db.from("support_case").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("slaBreached", true).not("status", "in", OPEN_CASE_STATUSES)
      : skip(),
    seeCases
      ? db.from("support_case").select("id", { count: "exact", head: true })
          .is("deletedAt", null).not("status", "in", OPEN_CASE_STATUSES)
          .is("ownerUserId", null).is("teamId", null)
      : skip(),

    // ---- partners
    seePartners
      ? db.from("partner").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("status", "ACTIVE")
      : skip(),
    // Owed to partners: in progress on deals already won.
    seePartners
      ? db.from("partner_commission").select("partnerAmount, opportunity!inner ( stage )")
          .eq("status", "IN_PROGRESS").eq("opportunity.stage", "CLOSED_WON")
      : { data: [] },
    // Partners waiting on an answer to a rate request.
    seePartners
      ? db.from("partner_commission").select("id", { count: "exact", head: true })
          .eq("requestStatus", "PENDING")
      : skip(),
    seePartners
      ? db.from("partner").select("id", { count: "exact", head: true })
          .is("deletedAt", null).eq("status", "ACTIVE")
          .not("agreementExpiryDate", "is", null).lte("agreementExpiryDate", agreementHorizon)
      : skip(),
  ]);

  const sum = (res: { data?: unknown }, column: string) =>
    ((res.data ?? []) as Record<string, unknown>[])
      .reduce((total, row) => total.plus(toDecimal(row[column])), toDecimal(0))
      .toFixed(2);

  const n = (res: { count?: number | null }) => res.count ?? 0;

  return {
    visible: {
      sales: seeSales,
      finance: seeFinance,
      delivery: seeProjects,
      service: seeCases,
      partners: seePartners,
    },
    sales: {
      openDeals: n(openDeals),
      openValue: sum(openValueRows, "amount"),
      wonThisMonth: n(wonThisMonth),
      wonValueThisMonth: sum(wonValueRows, "amount"),
      newLeads: n(newLeads),
      leadsToFollowUp: n(leadsToFollowUp),
      quotesAwaitingReply: n(quotesOut),
      quoteValueOut: sum(quoteValueRows, "totalAmount"),
    },
    delivery: {
      activeProjects: n(activeProjects),
      atRiskProjects: n(atRiskProjects),
      milestonesDueSoon: n(milestonesDue),
      overdueTasks: n(overdueTasks),
      hoursAwaitingApproval: sum(hoursPending, "hours"),
    },
    finance: {
      outstanding: sum(outstandingRows, "outstandingAmount"),
      overdue: sum(overdueRows, "outstandingAmount"),
      overdueCount: ((overdueRows.data ?? []) as unknown[]).length,
      collectedThisMonth: sum(collectedRows, "amount"),
      unallocatedPayments: sum(unallocatedRows, "unallocatedAmount"),
      draftInvoices: n(draftInvoices),
    },
    service: {
      openCases: n(openCases),
      criticalCases: n(criticalCases),
      breachedSla: n(breachedSla),
      unassignedCases: n(unassignedCases),
    },
    partners: {
      activePartners: n(activePartners),
      commissionPayable: sum(payableRows, "partnerAmount"),
      commissionPendingApproval: n(pendingApproval),
      agreementsExpiringSoon: n(expiringAgreements),
    },
  };
}

/** Shapes app_dashboard_summary's row like the separate queries' result: counts as numbers, money to two places. */
function fromSummaryRow(row: Record<string, Record<string, unknown>>, visible: ModuleSummary["visible"]): ModuleSummary {
  const n = (section: string, key: string) => Number(row[section]?.[key] ?? 0);
  const money = (section: string, key: string) => toDecimal(String(row[section]?.[key] ?? 0)).toFixed(2);
  return {
    visible,
    sales: {
      openDeals: n("sales", "openDeals"),
      openValue: money("sales", "openValue"),
      wonThisMonth: n("sales", "wonThisMonth"),
      wonValueThisMonth: money("sales", "wonValueThisMonth"),
      newLeads: n("sales", "newLeads"),
      leadsToFollowUp: n("sales", "leadsToFollowUp"),
      quotesAwaitingReply: n("sales", "quotesAwaitingReply"),
      quoteValueOut: money("sales", "quoteValueOut"),
    },
    delivery: {
      activeProjects: n("delivery", "activeProjects"),
      atRiskProjects: n("delivery", "atRiskProjects"),
      milestonesDueSoon: n("delivery", "milestonesDueSoon"),
      overdueTasks: n("delivery", "overdueTasks"),
      hoursAwaitingApproval: money("delivery", "hoursAwaitingApproval"),
    },
    finance: {
      outstanding: money("finance", "outstanding"),
      overdue: money("finance", "overdue"),
      overdueCount: n("finance", "overdueCount"),
      collectedThisMonth: money("finance", "collectedThisMonth"),
      unallocatedPayments: money("finance", "unallocatedPayments"),
      draftInvoices: n("finance", "draftInvoices"),
    },
    service: {
      openCases: n("service", "openCases"),
      criticalCases: n("service", "criticalCases"),
      breachedSla: n("service", "breachedSla"),
      unassignedCases: n("service", "unassignedCases"),
    },
    partners: {
      activePartners: n("partners", "activePartners"),
      commissionPayable: money("partners", "commissionPayable"),
      commissionPendingApproval: n("partners", "commissionPendingApproval"),
      agreementsExpiringSoon: n("partners", "agreementsExpiringSoon"),
    },
  };
}

/**
 * Things that need someone to act, newest concern first.
 *
 * Distinct from the counts above: a count tells you the shape of the business,
 * this tells you what is going wrong right now.
 */
/**
 * The delivery portfolio, deep enough to run a week from.
 *
 * The delivery view had four counts and a list of projects by hours, which says
 * how busy people are and nothing about whether the work is worth doing. The
 * questions a delivery lead actually opens a dashboard with are: are we making
 * money on this, who is overloaded, what is about to slip, and what have we not
 * billed yet. None of those were answerable.
 *
 * Everything is derived from three reads rather than a query per figure. Time is
 * the expensive one — PostgREST has no aggregate, so hours are summed here — but
 * the row count is bounded by what the reader may see, and doing it once serves
 * margin, utilisation and the unbilled figure together.
 *
 * Rejected time is excluded throughout: it was disputed and thrown out, so
 * counting it would overstate both effort and cost.
 */
/**
 * Sales beyond the pipeline total: how deals move, and how often they land.
 *
 * The sales view had four figures and a stage bar, which says what is in the
 * pipeline and nothing about whether it is moving. The questions a sales lead
 * actually asks are: how many of these do we win, how long do they take, where do
 * they get stuck, and who is carrying the number. Each needs history, not a
 * snapshot.
 *
 * Win rate counts only closed deals. Including open ones would drag the rate
 * toward zero simply because most of the pipeline has not been decided yet — a
 * healthy pipeline would look like a failing one.
 */
/**
 * Support load, split by the things that change what you do about it.
 *
 * Four counts told you how many cases were open and nothing about their shape.
 * Whether twenty open cases is fine or a crisis depends on how old they are, who
 * they belong to, and whether they are arriving faster than they close — none of
 * which a total shows.
 */
export async function getServiceAnalytics() {
  await requirePermission(PERMISSIONS.CASE_READ);

  const db = await supabaseServer();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  const [openRes, recentRes] = await Promise.all([
    db
      .from("support_case")
      .select(
        `id, caseNumber, subject, status, priority, createdAt, slaBreached,
         resolutionDueAt, ownerUserId,
         owner:app_user!support_case_ownerUserId_fkey ( fullName ),
         account ( id, name )`,
      )
      .is("deletedAt", null)
      .not("status", "in", '("CLOSED","CANCELLED","RESOLVED")'),
    // Opened and resolved in the window, for the arrival-versus-clearance rate.
    db
      .from("support_case")
      .select("id, createdAt, resolvedAt, status")
      .is("deletedAt", null)
      .gte("createdAt", thirtyDaysAgo.toISOString()),
  ]);

  const open = ((openRes.data ?? []) as Record<string, any>[]).map((c) => {
    const owner = one(c.owner as never) as { fullName: string } | null;
    const account = one(c.account as never) as { id: string; name: string } | null;
    const ageDays = c.createdAt
      ? Math.round((now.getTime() - new Date(String(c.createdAt)).getTime()) / 86_400_000)
      : 0;
    const overdue =
      Boolean(c.slaBreached) ||
      (c.resolutionDueAt ? new Date(String(c.resolutionDueAt)) < now : false);
    return {
      id: String(c.id),
      caseNumber: String(c.caseNumber),
      subject: String(c.subject),
      priority: String(c.priority),
      status: String(c.status),
      ownerName: owner?.fullName ?? null,
      accountName: account?.name ?? null,
      ageDays,
      overdue,
    };
  });

  // Age bands, because a case open for two days and one open for two months are
  // different problems wearing the same badge.
  const ageBands = [
    { label: "Today", min: 0, max: 0 },
    { label: "1–3 days", min: 1, max: 3 },
    { label: "4–7 days", min: 4, max: 7 },
    { label: "1–4 weeks", min: 8, max: 30 },
    { label: "Over a month", min: 31, max: Infinity },
  ].map((b) => ({
    label: b.label,
    count: open.filter((c) => c.ageDays >= b.min && c.ageDays <= b.max).length,
    stale: b.min >= 8,
  }));

  const byPriority = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => ({
    priority: p,
    count: open.filter((c) => c.priority === p).length,
  })).filter((r) => r.count > 0);

  const byOwner = new Map<string, { name: string; count: number; overdue: number }>();
  for (const c of open) {
    const name = c.ownerName ?? "Unassigned";
    const f = byOwner.get(name) ?? { name, count: 0, overdue: 0 };
    f.count += 1;
    if (c.overdue) f.overdue += 1;
    byOwner.set(name, f);
  }

  const recent = (recentRes.data ?? []) as Record<string, any>[];
  const opened = recent.length;
  const resolved = recent.filter((c) => c.resolvedAt).length;

  return {
    open,
    ageBands,
    byPriority,
    byOwner: [...byOwner.values()].sort((a, b) => b.count - a.count),
    oldest: open.slice().sort((a, b) => b.ageDays - a.ageDays).slice(0, 8),
    // Above 100% means cases are arriving faster than they are being closed,
    // which is the single number that says whether the queue is growing.
    openedLast30: opened,
    resolvedLast30: resolved,
    arrivalRate: resolved > 0 ? (opened / resolved) * 100 : null,
    avgAgeDays: open.length
      ? Math.round(open.reduce((s, c) => s + c.ageDays, 0) / open.length)
      : 0,
  };
}

/**
 * Partner performance and what is owed, per partner rather than in total.
 *
 * The commission ledger showed four totals, which says how much is outstanding
 * and nothing about who earned it or who is actually producing. A partner
 * programme is managed one partner at a time.
 */
export async function getPartnerAnalytics() {
  await requirePermission(PERMISSIONS.PARTNER_READ);

  const db = await supabaseServer();

  const [partnersRes, commissionsRes, linksRes] = await Promise.all([
    db
      .from("partner")
      .select("id, partnerNumber, displayName, partnerType, tier, status, agreementExpiryDate")
      .is("deletedAt", null),
    db
      .from("partner_commission")
      .select("id, partnerId, partnerAmount, status, opportunity ( stage )"),
    db
      .from("opportunity")
      .select("sourcePartnerId, stage, amount")
      .not("sourcePartnerId", "is", null)
      .is("deletedAt", null),
  ]);

  const partners = (partnersRes.data ?? []) as Record<string, any>[];
  const commissions = (commissionsRes.data ?? []) as Record<string, any>[];

  // Deals per partner, split won versus still open.
  const deals = new Map<string, { won: number; wonValue: number; open: number; openValue: number }>();
  for (const opp of (linksRes.data ?? []) as Record<string, any>[]) {
    const key = String(opp.sourcePartnerId);
    const f = deals.get(key) ?? { won: 0, wonValue: 0, open: 0, openValue: 0 };
    if (opp.stage === "CLOSED_WON") {
      f.won += 1;
      f.wonValue += Number(opp.amount ?? 0);
    } else if (opp.stage !== "CLOSED_LOST") {
      f.open += 1;
      f.openValue += Number(opp.amount ?? 0);
    }
    deals.set(key, f);
  }

  const rows = partners.map((p) => {
    const theirs = commissions.filter((c) => String(c.partnerId) === String(p.id));
    const won = (c: Record<string, any>) =>
      (one(c.opportunity as never) as { stage?: string } | null)?.stage === "CLOSED_WON";
    const sum = (pick: (c: Record<string, any>) => boolean) =>
      theirs.filter(pick).reduce((s, c) => s + Number(c.partnerAmount ?? 0), 0);

    const d = deals.get(String(p.id)) ?? { won: 0, wonValue: 0, open: 0, openValue: 0 };
    const expiry = p.agreementExpiryDate ? String(p.agreementExpiryDate) : null;
    const daysToExpiry = expiry
      ? Math.round((new Date(expiry).getTime() - Date.now()) / 86_400_000)
      : null;

    return {
      id: String(p.id),
      name: String(p.displayName),
      partnerNumber: String(p.partnerNumber),
      tier: String(p.tier ?? "—"),
      status: String(p.status),
      dealsWon: d.won,
      dealsOpen: d.open,
      revenueSourced: d.wonValue,
      pipelineSourced: d.openValue,
      // What the partner is paid, after withholding. Earned means won: paid,
      // or owed on a won deal. Pending is the estimate on deals still open.
      earned: sum((c) => c.status === "PAID" || (c.status === "IN_PROGRESS" && won(c))),
      payable: sum((c) => c.status === "IN_PROGRESS" && won(c)),
      paid: sum((c) => c.status === "PAID"),
      pending: sum((c) => c.status === "IN_PROGRESS" && !won(c)),
      daysToExpiry,
      // A partner who cannot earn is worth flagging: an inactive partner gets no
      // commission on new deals, and a lapsed agreement needs renewing.
      blocked: String(p.status) !== "ACTIVE" || (daysToExpiry !== null && daysToExpiry < 0),
    };
  });

  return {
    rows: rows.sort((a, b) => b.earned - a.earned),
    totals: {
      activePartners: rows.filter((r) => r.status === "ACTIVE").length,
      blockedPartners: rows.filter((r) => r.blocked).length,
      revenueSourced: rows.reduce((s, r) => s + r.revenueSourced, 0),
      pipelineSourced: rows.reduce((s, r) => s + r.pipelineSourced, 0),
      earned: rows.reduce((s, r) => s + r.earned, 0),
      payable: rows.reduce((s, r) => s + r.payable, 0),
      pending: rows.reduce((s, r) => s + r.pending, 0),
      paid: rows.reduce((s, r) => s + r.paid, 0),
    },
    expiringSoon: rows
      .filter((r) => r.daysToExpiry !== null && r.daysToExpiry >= 0 && r.daysToExpiry <= 60)
      .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0)),
  };
}

export async function getSalesAnalytics() {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);

  const db = await supabaseServer();
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const [closedRes, openRes, leadRes] = await Promise.all([
    db
      .from("opportunity")
      .select("id, name, stage, amount, createdAt, actualCloseDate, lossReason, ownerUserId, owner:app_user!opportunity_ownerUserId_fkey ( fullName )")
      .is("deletedAt", null)
      .in("stage", ["CLOSED_WON", "CLOSED_LOST"])
      .gte("actualCloseDate", ninetyDaysAgo.toISOString().slice(0, 10)),
    db
      .from("opportunity")
      .select("id, name, stage, amount, createdAt, expectedCloseDate, owner:app_user!opportunity_ownerUserId_fkey ( fullName ), account ( name )")
      .is("deletedAt", null)
      .not("stage", "in", '("CLOSED_WON","CLOSED_LOST")'),
    db
      .from("lead")
      .select("id, status, createdAt, convertedAt")
      .is("deletedAt", null)
      .gte("createdAt", ninetyDaysAgo.toISOString()),
  ]);

  const closed = (closedRes.data ?? []) as Record<string, any>[];
  const won = closed.filter((o) => o.stage === "CLOSED_WON");
  const lost = closed.filter((o) => o.stage === "CLOSED_LOST");

  // Days from creation to close, averaged over won deals only — a lost deal's
  // duration measures how long it took to give up, which is a different number.
  const cycleDays = won
    .filter((o) => o.createdAt && o.actualCloseDate)
    .map((o) => {
      const from = new Date(String(o.createdAt)).getTime();
      const to = new Date(String(o.actualCloseDate)).getTime();
      return Math.max(0, Math.round((to - from) / 86_400_000));
    });

  const avgCycleDays = cycleDays.length
    ? Math.round(cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length)
    : null;

  const wonValue = won.reduce((s, o) => s.plus(toDecimal(o.amount)), toDecimal(0));
  const lostValue = lost.reduce((s, o) => s.plus(toDecimal(o.amount)), toDecimal(0));

  // Why deals are lost, which is the only field that tells you what to change.
  const lossReasons = new Map<string, { reason: string; count: number; value: number }>();
  for (const o of lost) {
    const reason = String(o.lossReason ?? "Not recorded");
    const found = lossReasons.get(reason) ?? { reason, count: 0, value: 0 };
    found.count += 1;
    found.value += Number(o.amount ?? 0);
    lossReasons.set(reason, found);
  }

  // Per owner, so it is visible who is carrying the number.
  const byOwner = new Map<string, { name: string; open: number; openValue: number; won: number; wonValue: number }>();
  for (const o of (openRes.data ?? []) as Record<string, any>[]) {
    const owner = one(o.owner as never) as { fullName: string } | null;
    const name = owner?.fullName ?? "Unassigned";
    const f = byOwner.get(name) ?? { name, open: 0, openValue: 0, won: 0, wonValue: 0 };
    f.open += 1;
    f.openValue += Number(o.amount ?? 0);
    byOwner.set(name, f);
  }
  for (const o of won) {
    const owner = one(o.owner as never) as { fullName: string } | null;
    const name = owner?.fullName ?? "Unassigned";
    const f = byOwner.get(name) ?? { name, open: 0, openValue: 0, won: 0, wonValue: 0 };
    f.won += 1;
    f.wonValue += Number(o.amount ?? 0);
    byOwner.set(name, f);
  }

  // Deals whose expected close date has passed — the pipeline's dead weight.
  const today = new Date().toISOString().slice(0, 10);
  const stalled = ((openRes.data ?? []) as Record<string, any>[])
    .filter((o) => o.expectedCloseDate && String(o.expectedCloseDate) < today)
    .map((o) => {
      const account = one(o.account as never) as { name: string } | null;
      const owner = one(o.owner as never) as { fullName: string } | null;
      const days = Math.round(
        (Date.now() - new Date(String(o.expectedCloseDate)).getTime()) / 86_400_000,
      );
      return {
        id: String(o.id),
        name: String(o.name),
        accountName: account?.name ?? null,
        ownerName: owner?.fullName ?? null,
        amount: Number(o.amount ?? 0),
        daysOverdue: days,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const leads = (leadRes.data ?? []) as Record<string, any>[];
  const convertedLeads = leads.filter((l) => l.convertedAt).length;

  return {
    winRate: closed.length ? (won.length / closed.length) * 100 : null,
    wonCount: won.length,
    lostCount: lost.length,
    wonValue: Number(wonValue),
    lostValue: Number(lostValue),
    avgCycleDays,
    avgDealSize: won.length ? Number(wonValue) / won.length : null,
    leadConversionRate: leads.length ? (convertedLeads / leads.length) * 100 : null,
    leadsCreated: leads.length,
    leadsConverted: convertedLeads,
    lossReasons: [...lossReasons.values()].sort((a, b) => b.count - a.count),
    byOwner: [...byOwner.values()].sort((a, b) => b.openValue - a.openValue),
    stalled,
  };
}

/**
 * Receivables ageing, and how long money actually takes to arrive.
 *
 * "Overdue: 400,000" is one number covering a bill a week late and one six months
 * gone, which are entirely different problems. Bucketing by age is the standard
 * finance view because the further right the money sits, the less of it comes
 * back.
 */
export async function getFinanceAnalytics() {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  const [openRes, paidRes] = await Promise.all([
    db
      .from("invoice")
      .select("id, invoiceNumber, totalAmount, outstandingAmount, dueDate, invoiceDate, account ( id, name )")
      .is("deletedAt", null)
      .not("status", "in", '("DRAFT","CANCELLED","PAID","WRITTEN_OFF")')
      .gt("outstandingAmount", 0),
    // Paid invoices from the last 90 days, for the average days-to-pay.
    db
      .from("invoice")
      .select("invoiceDate, dueDate, updatedAt, totalAmount")
      .is("deletedAt", null)
      .eq("status", "PAID")
      .gte("updatedAt", new Date(today.getTime() - 90 * 86_400_000).toISOString()),
  ]);

  const open = ((openRes.data ?? []) as Record<string, any>[]).map((i) => {
    const account = one(i.account as never) as { id: string; name: string } | null;
    const due = String(i.dueDate);
    const daysOverdue = due < todayISO
      ? Math.round((today.getTime() - new Date(due).getTime()) / 86_400_000)
      : 0;
    return {
      id: String(i.id),
      invoiceNumber: String(i.invoiceNumber),
      accountId: account?.id ?? null,
      accountName: account?.name ?? "Unknown",
      outstanding: Number(i.outstandingAmount ?? 0),
      dueDate: due,
      daysOverdue,
    };
  });

  // The standard ageing ladder. Current is money not yet due, which is healthy
  // and must not be mixed in with the overdue buckets.
  const buckets = [
    { label: "Current", min: -Infinity, max: 0 },
    { label: "1–30 days", min: 1, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "Over 90 days", min: 91, max: Infinity },
  ].map((b) => {
    const rows = open.filter((i) => i.daysOverdue >= b.min && i.daysOverdue <= b.max);
    return {
      label: b.label,
      count: rows.length,
      value: rows.reduce((s, i) => s + i.outstanding, 0),
      overdue: b.min > 0,
    };
  });

  // Who owes the most, which is where a collections call actually goes.
  const byCustomer = new Map<string, { id: string | null; name: string; value: number; count: number; worstDays: number }>();
  for (const i of open) {
    const f = byCustomer.get(i.accountName) ?? {
      id: i.accountId, name: i.accountName, value: 0, count: 0, worstDays: 0,
    };
    f.value += i.outstanding;
    f.count += 1;
    f.worstDays = Math.max(f.worstDays, i.daysOverdue);
    byCustomer.set(i.accountName, f);
  }

  const paid = (paidRes.data ?? []) as Record<string, any>[];
  const daysToPay = paid
    .filter((i) => i.invoiceDate && i.updatedAt)
    .map((i) =>
      Math.max(0, Math.round(
        (new Date(String(i.updatedAt)).getTime() - new Date(String(i.invoiceDate)).getTime()) / 86_400_000,
      )),
    );

  return {
    buckets,
    totalOutstanding: open.reduce((s, i) => s + i.outstanding, 0),
    totalOverdue: open.filter((i) => i.daysOverdue > 0).reduce((s, i) => s + i.outstanding, 0),
    byCustomer: [...byCustomer.values()].sort((a, b) => b.value - a.value),
    worstInvoices: open.filter((i) => i.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue),
    avgDaysToPay: daysToPay.length
      ? Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length)
      : null,
    paidCount: paid.length,
  };
}

/**
 * Delivery analytics for the dashboard.
 *
 * Two kinds of figure live here and they are deliberately kept apart:
 *
 *   - **Period figures** answer "what happened between these dates" — hours
 *     logged, tasks completed, revenue earned. They respect the range.
 *   - **Point-in-time figures** answer "what is true now" — tasks open, work
 *     overdue, people over-allocated. They ignore the range, because "tasks
 *     open in August" is not a real quantity. Anything returned under
 *     `current` is of this second kind, and the UI labels it as of today.
 *
 * Collapsing the two would produce numbers that look authoritative and mean
 * nothing, which is worse than showing fewer of them.
 */
export async function getDeliveryAnalytics(range: DateRange = resolveRange({}), filters: DeliveryFilters = {}) {
  const ratesVisible = can(await requireUser(), PERMISSIONS.PROJECT_RATES_READ);
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();
  const todayDay = new Date().toISOString().slice(0, 10);

  // Time logs are fetched for the range, and separately for the span before it,
  // so every period figure can be shown against what it was doing previously.
  const prev = previousRange(range);

  const logSelect =
    "id, projectId, projectTaskId, userId, hours, billable, approvalStatus, workDate";

  const rangedLogs = (from: string | null, to: string | null) => {
    let q = db
      .from("time_log")
      .select(logSelect)
      .not("projectId", "is", null)
      .neq("approvalStatus", "REJECTED");
    if (from) q = q.gte("workDate", from);
    if (to) q = q.lte("workDate", to);
    return q.limit(20000);
  };

  const [projectsRes, logsRes, prevLogsRes, tasksRes, milestonesRes, membersRes, usersRes] =
    await Promise.all([
      db
        .from("project")
        .select(
          `id, name, projectNumber, status, health, contractValue, currencyCode,
           approvedHours, startDate, plannedEndDate, completionPercent, projectType,
           account ( id, name )`,
        )
        .is("deletedAt", null)
        .not("status", "in", '("COMPLETED","CANCELLED")'),

      rangedLogs(range.from, range.to),
      prev ? rangedLogs(prev.from, prev.to) : Promise.resolve({ data: [], error: null }),

      // Every task on a live project. Both kinds of figure come from this one
      // read: what is open now, and what was completed inside the range.
      db
        .from("project_task")
        .select(
          `id, name, projectId, assignedUserId, status, priority, dueDate,
           completedDate, estimatedHours, completionPercent, createdAt,
           project!inner ( id, name, projectNumber, status, deletedAt )`,
        )
        .is("project.deletedAt", null)
        .not("project.status", "in", '("COMPLETED","CANCELLED")')
        .limit(20000),

      db
        .from("milestone")
        .select("id, name, dueDate, billingAmount, invoicedAt, project!inner ( id, name, deletedAt )")
        .is("invoicedAt", null)
        .not("billingAmount", "is", null),

      db
        .from("project_member")
        .select("userId, projectId, allocationPercent, active, project!inner ( id, status, deletedAt )")
        .eq("active", true)
        .is("project.deletedAt", null)
        .in("project.status", ["PLANNING", "ACTIVE", "AT_RISK"]),

      db
        .from("app_user")
        .select("id, fullName, jobTitle")
        .eq("status", "ACTIVE")
        .is("deletedAt", null),
    ]);

  // A broken query and an empty result are different things: letting a failed
  // select fall through as zero would report a healthy, idle delivery team.
  for (const [what, res] of [
    ["projects", projectsRes], ["time logs", logsRes], ["previous time logs", prevLogsRes], ["tasks", tasksRes],
    ["milestones", milestonesRes], ["project members", membersRes], ["users", usersRes],
  ] as const) {
    if (res.error) throw new Error(`Delivery analytics could not load ${what}: ${res.error.message}`);
  }

  const allProjects: Record<string, any>[] = (projectsRes.data ?? []).map((p: Record<string, any>) => ({
    ...p,
    account: one(p.account as never) as { id: string; name: string } | null,
  }));

  const allTasks: Record<string, any>[] = ((tasksRes.data ?? []) as Record<string, any>[]).map(
    (t) => ({ ...t, project: one(t.project as never) as Record<string, any> | null }),
  );

  const allLogs = await withRateSnapshots("time_log", (logsRes.data ?? []) as Array<Record<string, any> & {id: string}>);
  const allPrevLogs = await withRateSnapshots("time_log", (prevLogsRes.data ?? []) as Array<Record<string, any> & {id: string}>);
  const allMembers = ((membersRes.data ?? []) as Record<string, any>[]);
  const allUsers = (usersRes.data ?? []) as Record<string, any>[];

  const filterOptions = {
    resources: allUsers.map((u) => ({ id: String(u.id), name: String(u.fullName) })).sort((a, b) => a.name.localeCompare(b.name)),
    projects: allProjects.map((p) => ({ id: String(p.id), name: String(p.name) })).sort((a, b) => a.name.localeCompare(b.name)),
    statuses: [...new Set(allProjects.map((p) => String(p.status)))].sort(),
    health: [...new Set(allProjects.map((p) => String(p.health ?? "GREEN")))].sort(),
  };
  const { projects, tasks, logs, prevLogs, members, users, projectIds, narrowProjects } = filterDeliveryData(
    { projects: allProjects, tasks: allTasks, logs: allLogs, prevLogs: allPrevLogs, members: allMembers, users: allUsers }, filters,
  );

  // ---- Per-project money and hours, over the range -------------------------
  interface Bucket {
    hours: ReturnType<typeof toDecimal>;
    billableHours: ReturnType<typeof toDecimal>;
    revenue: ReturnType<typeof toDecimal>;
    cost: ReturnType<typeof toDecimal>;
    unapprovedHours: ReturnType<typeof toDecimal>;
    unbilledValue: ReturnType<typeof toDecimal>;
  }
  const zero = (): Bucket => ({
    hours: toDecimal(0), billableHours: toDecimal(0), revenue: toDecimal(0),
    cost: toDecimal(0), unapprovedHours: toDecimal(0), unbilledValue: toDecimal(0),
  });

  const byProject = new Map<string, Bucket>();
  for (const log of logs) {
    const key = String(log.projectId);
    const b = byProject.get(key) ?? zero();
    const hours = toDecimal(log.hours);

    b.hours = b.hours.plus(hours);
    b.cost = b.cost.plus(hours.times(toDecimal(log.costRate)));

    if (log.billable) {
      b.billableHours = b.billableHours.plus(hours);
      const value = hours.times(toDecimal(log.billingRate));
      // Revenue counts approved time only — the same rule the project page
      // uses, so the two never disagree about what a project has earned.
      if (log.approvalStatus === "APPROVED") b.revenue = b.revenue.plus(value);
      else b.unbilledValue = b.unbilledValue.plus(value);
    }
    if (log.approvalStatus !== "APPROVED") {
      b.unapprovedHours = b.unapprovedHours.plus(hours);
    }
    byProject.set(key, b);
  }

  // ---- Tasks ---------------------------------------------------------------
  const OPEN_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW"];
  const isOpen = (t: Record<string, any>) => OPEN_STATUSES.includes(String(t.status));

  const openTasks = tasks.filter(isOpen);
  const overdueTasks = openTasks.filter((t) => t.dueDate && String(t.dueDate) < todayDay);
  const blockedTasks = openTasks.filter((t) => String(t.status) === "BLOCKED");
  const unassignedTasks = openTasks.filter((t) => !t.assignedUserId);
  const inReviewTasks = openTasks.filter((t) => String(t.status) === "UNDER_REVIEW");
  const notStartedTasks = openTasks.filter((t) => String(t.status) === "NOT_STARTED");
  const inProgressTasks = openTasks.filter((t) => String(t.status) === "IN_PROGRESS");

  // Created and completed inside the range — the flow figures. A backlog that
  // grows faster than it drains is the thing a delivery lead needs to see, and
  // neither number says it alone.
  const createdInRange = tasks.filter((t) => withinRange(range, t.createdAt));
  const completedInRange = tasks.filter(
    (t) => String(t.status) === "COMPLETED" && withinRange(range, t.completedDate),
  );

  const dueSoon = openTasks.filter(
    (t) => t.dueDate && String(t.dueDate) >= todayDay && String(t.dueDate) <= addDays(todayDay, 7),
  );

  // Hours booked per task, for estimate accuracy and remaining effort. Built
  // from range logs only where it describes the range, and that is stated at
  // each use rather than silently mixed.
  const hoursByTask = new Map<string, ReturnType<typeof toDecimal>>();
  for (const log of logs) {
    if (!log.projectTaskId) continue;
    const k = String(log.projectTaskId);
    hoursByTask.set(k, (hoursByTask.get(k) ?? toDecimal(0)).plus(toDecimal(log.hours)));
  }

  // Estimate accuracy over tasks completed in the range that carry both an
  // estimate and logged time. The sample size travels with the ratio so a
  // figure drawn from two tasks is not mistaken for a track record.
  const estimated = completedInRange
    .map((t) => ({
      estimate: toDecimal(t.estimatedHours ?? 0),
      actual: hoursByTask.get(String(t.id)) ?? toDecimal(0),
    }))
    .filter((e) => e.estimate.greaterThan(0) && e.actual.greaterThan(0));
  const totalEstimate = estimated.reduce((a, e) => a.plus(e.estimate), toDecimal(0));
  const totalActual = estimated.reduce((a, e) => a.plus(e.actual), toDecimal(0));

  // On-time delivery, judged only on tasks that carried a due date — counting
  // every completed task would quietly reward leaving dates off.
  const datedCompleted = completedInRange.filter((t) => t.dueDate && t.completedDate);
  const onTime = datedCompleted.filter((t) => String(t.completedDate) <= String(t.dueDate));

  // Remaining estimated effort on open work, floored at zero per task: work
  // already past its estimate has no negative time left to give.
  const remainingHours = openTasks.reduce((acc, t) => {
    const est = toDecimal(t.estimatedHours ?? 0);
    if (est.isZero()) return acc;
    const spent = hoursByTask.get(String(t.id)) ?? toDecimal(0);
    const left = est.minus(spent);
    return acc.plus(left.greaterThan(0) ? left : toDecimal(0));
  }, toDecimal(0));

  // ---- Resources -----------------------------------------------------------
  const sumBy = <T,>(rows: T[], pick: (r: T) => unknown) =>
    rows.reduce((a, r) => a.plus(toDecimal(pick(r) as never)), toDecimal(0));

  const allocationByUser = new Map<string, number>();
  for (const m of members) {
    const k = String(m.userId);
    allocationByUser.set(k, (allocationByUser.get(k) ?? 0) + Number(m.allocationPercent ?? 0));
  }

  const hoursByUser = new Map<string, { hours: ReturnType<typeof toDecimal>; billable: ReturnType<typeof toDecimal> }>();
  for (const log of logs) {
    const k = String(log.userId);
    const acc = hoursByUser.get(k) ?? { hours: toDecimal(0), billable: toDecimal(0) };
    acc.hours = acc.hours.plus(toDecimal(log.hours));
    if (log.billable) acc.billable = acc.billable.plus(toDecimal(log.hours));
    hoursByUser.set(k, acc);
  }

  // Where each person's hours actually went, by task and by project. This is
  // the "current allocation" question in its useful form: a percentage says
  // someone is booked, this says what they are booked *on*.
  const taskNameById = new Map(allTasks.map((t) => [String(t.id), t]));
  const projectNameById = new Map(projects.map((p: Record<string, any>) => [String(p.id), p]));

  const userTaskHours = new Map<string, Map<string, ReturnType<typeof toDecimal>>>();
  const userProjectHours = new Map<string, Map<string, ReturnType<typeof toDecimal>>>();
  for (const log of logs) {
    const u = String(log.userId);
    if (log.projectTaskId) {
      const m = userTaskHours.get(u) ?? new Map();
      const k = String(log.projectTaskId);
      m.set(k, (m.get(k) ?? toDecimal(0)).plus(toDecimal(log.hours)));
      userTaskHours.set(u, m);
    }
    if (log.projectId) {
      const m = userProjectHours.get(u) ?? new Map();
      const k = String(log.projectId);
      m.set(k, (m.get(k) ?? toDecimal(0)).plus(toDecimal(log.hours)));
      userProjectHours.set(u, m);
    }
  }

  // Open tasks per person, so someone with no logged time still shows what they
  // are holding. Allocation without work in progress is its own signal.
  const openTasksByUser = new Map<string, Record<string, any>[]>();
  for (const t of openTasks) {
    if (!t.assignedUserId) continue;
    const k = String(t.assignedUserId);
    openTasksByUser.set(k, [...(openTasksByUser.get(k) ?? []), t]);
  }

  const openTaskCountByUser = new Map<string, number>();
  const overdueTaskCountByUser = new Map<string, number>();
  for (const t of openTasks) {
    if (!t.assignedUserId) continue;
    const k = String(t.assignedUserId);
    openTaskCountByUser.set(k, (openTaskCountByUser.get(k) ?? 0) + 1);
    if (t.dueDate && String(t.dueDate) < todayDay) {
      overdueTaskCountByUser.set(k, (overdueTaskCountByUser.get(k) ?? 0) + 1);
    }
  }

  // Capacity is 8h per working day in the range. Public holidays are not
  // modelled anywhere in this system, so this is a deliberate Mon–Fri count
  // rather than a false precision.
  const days = workingDays(range);
  const capacityPerPerson = days === null ? null : toDecimal(days * 8);

  const people = users
    .map((u) => {
      const k = String(u.id);
      const h = hoursByUser.get(k) ?? { hours: toDecimal(0), billable: toDecimal(0) };
      const allocated = allocationByUser.get(k) ?? 0;
      const util =
        capacityPerPerson && capacityPerPerson.greaterThan(0)
          ? Number(h.hours.dividedBy(capacityPerPerson).times(100).toDecimalPlaces(1))
          : null;
      const billableUtil =
        capacityPerPerson && capacityPerPerson.greaterThan(0)
          ? Number(h.billable.dividedBy(capacityPerPerson).times(100).toDecimalPlaces(1))
          : null;
      return {
        id: k,
        fullName: String(u.fullName),
        jobTitle: u.jobTitle ? String(u.jobTitle) : null,
        allocatedPercent: allocated,
        projects: members.filter((m) => String(m.userId) === k).length,
        hours: Number(h.hours.toDecimalPlaces(1)),
        billableHours: Number(h.billable.toDecimalPlaces(1)),
        utilisationPercent: util,
        billableUtilisationPercent: billableUtil,
        openTasks: openTaskCountByUser.get(k) ?? 0,
        overdueTasks: overdueTaskCountByUser.get(k) ?? 0,

        /** Which tasks their logged hours went into, biggest first. */
        taskBreakdown: [...(userTaskHours.get(k) ?? new Map()).entries()]
          .map(([taskId, hrs]) => {
            const t = taskNameById.get(taskId);
            const proj = t ? projectNameById.get(String(t.projectId)) : null;
            return {
              id: taskId,
              name: t ? String(t.name) : "(task no longer on a live project)",
              status: t ? String(t.status) : null,
              projectId: t ? String(t.projectId) : null,
              projectName: proj ? String(proj.name) : null,
              hours: Number((hrs as ReturnType<typeof toDecimal>).toDecimalPlaces(1)),
            };
          })
          .sort((a, b) => b.hours - a.hours)
          .slice(0, 6),

        /** And which projects, for the person whose work spans several. */
        projectBreakdown: [...(userProjectHours.get(k) ?? new Map()).entries()]
          .map(([projectId, hrs]) => {
            const proj = projectNameById.get(projectId);
            return {
              id: projectId,
              name: proj ? String(proj.name) : "(project no longer live)",
              hours: Number((hrs as ReturnType<typeof toDecimal>).toDecimalPlaces(1)),
            };
          })
          .sort((a, b) => b.hours - a.hours),

        /**
         * What they are holding right now, for the person who is booked but has
         * logged nothing — allocation with no work in progress is its own signal.
         */
        currentTasks: (openTasksByUser.get(k) ?? [])
          .slice()
          .sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")))
          .slice(0, 6)
          .map((t) => {
            const proj = projectNameById.get(String(t.projectId));
            return {
              id: String(t.id),
              name: String(t.name),
              status: String(t.status),
              projectId: String(t.projectId),
              projectName: proj ? String(proj.name) : null,
              dueDate: t.dueDate ? String(t.dueDate) : null,
              overdue: Boolean(t.dueDate && String(t.dueDate) < todayDay),
              completionPercent: Number(t.completionPercent ?? 0),
            };
          }),
      };
    })
    .sort((a, b) => b.hours - a.hours || b.allocatedPercent - a.allocatedPercent);

  const overAllocated = people.filter((p) => p.allocatedPercent > 100);
  const unallocated = people.filter((p) => p.allocatedPercent === 0);
  const totalCapacity = capacityPerPerson ? capacityPerPerson.times(people.length) : null;
  const loggedTotal = sumBy(logs, (l) => l.hours);
  const billableTotal = sumBy(logs.filter((l) => l.billable), (l) => l.hours);

  // ---- Per-project rows ----------------------------------------------------
  const rows = projects.map((p: Record<string, any>) => {
    const pid = String(p.id);
    const b = byProject.get(pid) ?? zero();
    const margin = b.revenue.minus(b.cost);
    const marginPercent = b.revenue.greaterThan(0)
      ? Number(margin.dividedBy(b.revenue).times(100))
      : null;
    const approved = Number(p.approvedHours ?? 0);
    const burnPercent = approved > 0 ? (Number(b.hours) / approved) * 100 : null;

    const projectTasks = tasks.filter((t) => String(t.projectId) === pid);
    const projectOpen = projectTasks.filter(isOpen);

    return {
      id: pid,
      name: String(p.name),
      projectNumber: String(p.projectNumber),
      accountName: p.account?.name ?? null,
      projectType: String(p.projectType ?? "CUSTOMER"),
      status: String(p.status),
      health: String(p.health ?? "GREEN"),
      plannedEndDate: p.plannedEndDate ? String(p.plannedEndDate) : null,
      completionPercent: Number(p.completionPercent ?? 0),
      hours: Number(b.hours),
      billableHours: Number(b.billableHours),
      revenue: Number(b.revenue),
      cost: Number(b.cost),
      margin: Number(margin),
      marginPercent,
      unapprovedHours: Number(b.unapprovedHours),
      unbilledValue: Number(b.unbilledValue),
      burnPercent,
      overBudget: burnPercent !== null && burnPercent > 100,
      // Point-in-time, like every other task count here.
      totalTasks: projectTasks.length,
      openTasks: projectOpen.length,
      overdueTasks: projectOpen.filter((t) => t.dueDate && String(t.dueDate) < todayDay).length,
      blockedTasks: projectOpen.filter((t) => String(t.status) === "BLOCKED").length,
      completedTasks: projectTasks.filter((t) => String(t.status) === "COMPLETED").length,
      people: new Set(members.filter((m) => String(m.projectId) === pid).map((m) => String(m.userId))).size,
      // Past its planned end date and still not finished.
      overdue: Boolean(p.plannedEndDate && String(p.plannedEndDate) < todayDay),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      hours: acc.hours + r.hours,
      billableHours: acc.billableHours + r.billableHours,
      revenue: acc.revenue + r.revenue,
      cost: acc.cost + r.cost,
      unbilledValue: acc.unbilledValue + r.unbilledValue,
      unapprovedHours: acc.unapprovedHours + r.unapprovedHours,
    }),
    { hours: 0, billableHours: 0, revenue: 0, cost: 0, unbilledValue: 0, unapprovedHours: 0 },
  );

  // ---- Previous period, for direction --------------------------------------
  const prevHours = sumBy(prevLogs, (l) => l.hours);
  const prevBillable = sumBy(prevLogs.filter((l) => l.billable), (l) => l.hours);
  const prevRevenue = prevLogs
    .filter((l) => l.billable && l.approvalStatus === "APPROVED")
    .reduce((a, l) => a.plus(toDecimal(l.hours).times(toDecimal(l.billingRate))), toDecimal(0));
  const prevCompleted = tasks.filter(
    (t) =>
      String(t.status) === "COMPLETED" &&
      prev && t.completedDate &&
      String(t.completedDate) >= prev.from && String(t.completedDate) <= prev.to,
  ).length;

  // ---- Daily hours, for the trend -----------------------------------------
  const daily: { day: string; hours: number; billableHours: number }[] = [];
  if (range.from && range.to) {
    const byDay = new Map<string, { h: ReturnType<typeof toDecimal>; b: ReturnType<typeof toDecimal> }>();
    for (const l of logs) {
      const d = String(l.workDate).slice(0, 10);
      const acc = byDay.get(d) ?? { h: toDecimal(0), b: toDecimal(0) };
      acc.h = acc.h.plus(toDecimal(l.hours));
      if (l.billable) acc.b = acc.b.plus(toDecimal(l.hours));
      byDay.set(d, acc);
    }
    // Capped so a five-year range does not try to render 1,825 bars.
    const span = rangeDays(range) ?? 0;
    if (span > 0 && span <= 120) {
      for (let i = 0; i < span; i++) {
        const day = addDays(range.from, i);
        const v = byDay.get(day);
        daily.push({
          day,
          hours: Number((v?.h ?? toDecimal(0)).toDecimalPlaces(2)),
          billableHours: Number((v?.b ?? toDecimal(0)).toDecimalPlaces(2)),
        });
      }
    }
  }

  // ---- Milestones ----------------------------------------------------------
  const now = new Date();
  const in30 = new Date(now);
  in30.setDate(in30.getDate() + 30);

  const upcomingMilestones = ((milestonesRes.data ?? []) as Record<string, any>[])
    .map((m) => ({ row: m, project: one(m.project as never) as Record<string, any> | null }))
    .filter(({ row, project }) => project && !project.deletedAt && row.dueDate && (!narrowProjects || projectIds.has(project.id)))
    .filter(({ row }) => new Date(String(row.dueDate)) <= in30)
    .map(({ row, project }) => ({
      id: String(row.id),
      name: String(row.name),
      projectId: String(project!.id),
      projectName: String(project!.name),
      dueDate: String(row.dueDate),
      amount: Number(row.billingAmount ?? 0),
      overdue: new Date(String(row.dueDate)) < now,
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

  return {
    range,
    filterOptions,

    rows,

    ratesVisible,
    totals: {
      ...totals,
      margin: totals.revenue - totals.cost,
      marginPercent: totals.revenue > 0 ? ((totals.revenue - totals.cost) / totals.revenue) * 100 : null,
      billablePercent: totals.hours > 0 ? (totals.billableHours / totals.hours) * 100 : 0,
    },

    /**
     * What happened inside the range.
     */
    period: {
      hours: Number(loggedTotal.toDecimalPlaces(1)),
      billableHours: Number(billableTotal.toDecimalPlaces(1)),
      nonBillableHours: Number(loggedTotal.minus(billableTotal).toDecimalPlaces(1)),
      billablePercent: pct(Number(billableTotal), Number(loggedTotal)),
      entries: logs.length,
      tasksCreated: createdInRange.length,
      tasksCompleted: completedInRange.length,
      /** >0 means the backlog grew: more work arrived than was finished. */
      backlogChange: createdInRange.length - completedInRange.length,
      onTimePercent:
        datedCompleted.length === 0
          ? null
          : Math.round((onTime.length / datedCompleted.length) * 100),
      datedCompletedCount: datedCompleted.length,
      estimateAccuracyPercent: totalEstimate.isZero()
        ? null
        : Number(totalActual.dividedBy(totalEstimate).times(100).toDecimalPlaces(0)),
      estimateSampleSize: estimated.length,
      /** Team utilisation: hours logged against everyone's capacity. */
      utilisationPercent:
        totalCapacity && totalCapacity.greaterThan(0)
          ? Number(loggedTotal.dividedBy(totalCapacity).times(100).toDecimalPlaces(1))
          : null,
      billableUtilisationPercent:
        totalCapacity && totalCapacity.greaterThan(0)
          ? Number(billableTotal.dividedBy(totalCapacity).times(100).toDecimalPlaces(1))
          : null,
      capacityHours: totalCapacity ? Number(totalCapacity) : null,
      workingDays: days,
    },

    /** The same figures for the span immediately before, or null for all-time. */
    previous: prev
      ? {
          hours: Number(prevHours.toDecimalPlaces(1)),
          billableHours: Number(prevBillable.toDecimalPlaces(1)),
          revenue: Number(prevRevenue),
          tasksCompleted: prevCompleted,
        }
      : null,

    /**
     * True right now, whatever the range says. "Tasks open in August" is not a
     * real quantity, so these deliberately ignore the filter and the UI says so.
     */
    current: {
      activeProjects: rows.length,
      projectsAtRisk: rows.filter((r) => r.health === "RED" || r.health === "AMBER" || r.status === "AT_RISK").length,
      projectsOverdue: rows.filter((r) => r.overdue).length,
      projectsOverBudget: rows.filter((r) => r.overBudget).length,
      totalTasks: tasks.length,
      openTasks: openTasks.length,
      notStartedTasks: notStartedTasks.length,
      inProgressTasks: inProgressTasks.length,
      inReviewTasks: inReviewTasks.length,
      blockedTasks: blockedTasks.length,
      overdueTasks: overdueTasks.length,
      unassignedTasks: unassignedTasks.length,
      dueSoonTasks: dueSoon.length,
      completedTasksAllTime: tasks.filter((t) => String(t.status) === "COMPLETED").length,
      remainingHours: Number(remainingHours.toDecimalPlaces(1)),
      peopleActive: people.length,
      peopleOverAllocated: overAllocated.length,
      peopleUnallocated: unallocated.length,
      peopleBooked: people.filter((p) => p.allocatedPercent > 0).length,
    },

    people,

    /** The work most likely to need a decision today. */
    attention: {
      overdue: openTasks
        .filter((t) => t.dueDate && String(t.dueDate) < todayDay)
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
        .slice(0, 8)
        .map((t) => ({
          id: String(t.id),
          name: String(t.name),
          projectId: String(t.projectId),
          projectName: t.project ? String(t.project.name) : null,
          dueDate: String(t.dueDate),
          status: String(t.status),
          assignee: users.find((u) => String(u.id) === String(t.assignedUserId))?.fullName ?? null,
          daysLate: Math.max(
            0,
            Math.round(
              (new Date(`${todayDay}T00:00:00Z`).getTime() -
                new Date(`${String(t.dueDate)}T00:00:00Z`).getTime()) / 86_400_000,
            ),
          ),
        })),
      blocked: blockedTasks.slice(0, 8).map((t) => ({
        id: String(t.id),
        name: String(t.name),
        projectId: String(t.projectId),
        projectName: t.project ? String(t.project.name) : null,
        assignee: users.find((u) => String(u.id) === String(t.assignedUserId))?.fullName ?? null,
      })),
      unassigned: unassignedTasks.slice(0, 8).map((t) => ({
        id: String(t.id),
        name: String(t.name),
        projectId: String(t.projectId),
        projectName: t.project ? String(t.project.name) : null,
        dueDate: t.dueDate ? String(t.dueDate) : null,
      })),
    },

    daily,
    upcomingMilestones,
  };
}

/** `yyyy-mm-dd` plus n days, staying in date-only space. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function getAttentionItems() {
  const me = await requireUser();
  const db = await supabaseServer();
  const now = today();

  const [overdueInvoices, breachedCases, staleDeals, expiringAgreements, expiringContracts] = await Promise.all([
    can(me, PERMISSIONS.INVOICE_READ)
      ? db.from("invoice")
          .select("id, invoiceNumber, totalAmount, outstandingAmount, dueDate, currencyCode, account ( id, name )")
          .is("deletedAt", null)
          .not("status", "in", '("PAID","CANCELLED","WRITTEN_OFF","DRAFT")')
          .lt("dueDate", now)
          .order("dueDate")
          .limit(5)
      : { data: [] },
    can(me, PERMISSIONS.CASE_READ)
      ? db.from("support_case")
          .select("id, caseNumber, subject, priority, status, resolutionDueAt, account ( id, name )")
          .is("deletedAt", null)
          .not("status", "in", OPEN_CASE_STATUSES)
          .or(`slaBreached.eq.true,priority.eq.CRITICAL`)
          .order("resolutionDueAt")
          .limit(5)
      : { data: [] },
    can(me, PERMISSIONS.OPPORTUNITY_READ)
      ? db.from("opportunity")
          .select("id, opportunityNumber, name, stage, amount, currencyCode, expectedCloseDate, account ( id, name )")
          .is("deletedAt", null)
          .not("stage", "in", CLOSED_STAGES)
          .lt("expectedCloseDate", now)
          .order("expectedCloseDate")
          .limit(5)
      : { data: [] },
    can(me, PERMISSIONS.PARTNER_READ)
      ? db.from("partner")
          .select("id, displayName, partnerNumber, agreementExpiryDate, tier")
          .is("deletedAt", null)
          .eq("status", "ACTIVE")
          .not("agreementExpiryDate", "is", null)
          .lte("agreementExpiryDate", daysFromNow(60))
          .order("agreementExpiryDate")
          .limit(5)
      : { data: [] },
    // Contracts approaching their end date.
    //
    // The contract page already warns when one is inside its notice period, but
    // only once you open it — so the warning arrives for the contracts someone
    // happened to look at, which is not the set that needs it. An auto-renewing
    // contract nobody opens renews itself, which is the expensive case.
    //
    // 90 days rather than the 60 used for partner agreements: notice periods
    // here run to 90 by default, and a warning that arrives after the notice
    // window has closed is worse than none — it tells you about a decision you
    // can no longer make.
    // OPPORTUNITY_READ, not a contract permission: that is what listContracts
    // and the contracts page already require, and inventing a stricter gate
    // here would hide the warning from people who can open the contract itself.
    can(me, PERMISSIONS.OPPORTUNITY_READ)
      ? db.from("contract")
          .select("id, contractNumber, name, endDate, noticePeriodDays, renewalType, contractValue, currencyCode, account ( id, name )")
          .is("deletedAt", null)
          .eq("status", "ACTIVE")
          .lte("endDate", daysFromNow(90))
          .order("endDate")
          .limit(5)
      : { data: [] },
  ]);

  const first = <T,>(v: unknown): T | null =>
    Array.isArray(v) ? ((v[0] ?? null) as T | null) : ((v ?? null) as T | null);

  type Named = { id: string; name: string };

  return {
    overdueInvoices: (overdueInvoices.data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      account: first<Named>(r.account),
    })),
    breachedCases: (breachedCases.data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      account: first<Named>(r.account),
    })),
    staleDeals: (staleDeals.data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      account: first<Named>(r.account),
    })),
    expiringAgreements: expiringAgreements.data ?? [],
    expiringContracts: (expiringContracts.data ?? []).map((r: Record<string, unknown>) => {
      const end = new Date(String(r.endDate));
      const daysToEnd = Math.round((end.getTime() - Date.now()) / 86_400_000);
      // The notice period is what makes this urgent rather than merely upcoming:
      // once it has passed, an auto-renewing contract renews whatever anyone
      // decides afterwards. Defaults to 90 to match the contract page.
      const notice = r.noticePeriodDays == null ? 90 : Number(r.noticePeriodDays);
      return {
        ...r,
        account: first<Named>(r.account),
        daysToEnd,
        inNoticeWindow: daysToEnd <= notice,
        // An auto-renew inside its notice window is the expensive case: doing
        // nothing signs you up for another term.
        autoRenews: r.renewalType === "AUTO_RENEW",
      };
    }),
  };
}
