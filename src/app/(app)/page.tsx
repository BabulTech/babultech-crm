import Link from "next/link";
import {
  AlertTriangle, Target, Receipt, FolderKanban, LifeBuoy, Handshake,
} from "lucide-react";
import { toDecimal } from "@/lib/decimal";
import { supabaseServer } from "@/lib/supabase";
import { requireUser, can, scopeFilter, PERMISSIONS } from "@/lib/authz";
import { applyScope } from "@/lib/db";
import { getPipelineByStage } from "@/server/opportunities";
import { getPartnerCommissionTotals } from "@/server/partner-commissions";
import {
  getModuleSummary, getAttentionItems, getDeliveryAnalytics,
  getSalesAnalytics, getFinanceAnalytics, getServiceAnalytics, getPartnerAnalytics,
} from "@/server/dashboard";
import { getPayablesSummary } from "@/server/payables";
import { getPendingApprovals } from "@/server/approvals";
import { getPulse, getRecentChanges, getVisibleAuditTypes } from "@/server/pulse";
import { ModuleSummary } from "./module-summary";
import { PulseTile } from "./pulse-tile";
import { LiveIndicator, LiveClock, PulseDot } from "@/components/live-indicator";
import { ActivityStream } from "@/components/activity-stream";
import { DashboardViews, DashboardViewTransition, DashboardViewBody, type ViewKey } from "./dashboard-views";
import { DeliveryFiltersBar } from "./delivery-filters-bar";
import { resolveRange } from "@/lib/date-range";
import { SalesView } from "./views/sales-view";
import { FinanceView } from "./views/finance-view";
import { DeliveryView } from "./views/delivery-view";
import { ServiceView } from "./views/service-view";
import { PartnersView } from "./views/partners-view";
import {
  Card, CardHeader, CardTitle, CardContent, PageHeader,
  Badge, statusTone, Table, THead, TBody, TR, TH, TD, EmptyState,
} from "@/components/ui";
import { formatCompactMoney, formatMoney, formatDate, humanize, formatCompactMoneyTotal } from "@/lib/utils";

/**
 * The dashboard refreshes itself over a realtime socket, so a cached render
 * would be showing figures the socket has already announced as stale.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  // Which module view to show. Kept in the URL so a link to the sales dashboard
  // is a link to the sales dashboard — shareable, reloadable, and survivable
  // through the back button.
  searchParams: Promise<{
    view?: string;
    range?: string;
    from?: string;
    to?: string;
    days?: string;
    resource?: string;
    project?: string;
    projectStatus?: string;
    health?: string;
    timing?: string;
  }>;
}) {
  const user = await requireUser();

  // What this reader is allowed to be shown, decided once and applied to both
  // the data fetching and the layout below.
  //
  // These mirror the flags getModuleSummary computes for its own cards. The
  // module cards were already gated on those; the headline tiles, the pipeline
  // chart and the partner table were not, so a consultant opened the dashboard
  // to the company's cash position in 48-point type and found the polite
  // hiding three screens further down.
  // Resolved before anything fetches, because the analytics take it. Comes
  // straight from the address bar, so resolveRange treats every field as
  // untrusted and falls back rather than throwing.
  const rangeParams = await searchParams;
  const range = resolveRange(rangeParams);

  const seeSales = can(user, PERMISSIONS.OPPORTUNITY_READ);
  const seeFinance = can(user, PERMISSIONS.INVOICE_READ);
  const seePartners = can(user, PERMISSIONS.PARTNER_READ);
  const seeCases = can(user, PERMISSIONS.CASE_READ);
  const seeProjects = can(user, PERMISSIONS.PROJECT_READ);

  // Counts below are scoped the way every list screen is scoped. Without this
  // an OWN-scope consultant read a company-wide total: the rows stayed hidden,
  // but the number on the tile still announced how many there were.
  //
  // Invoices take no scope filter because the table has no owning user — a
  // receivable belongs to the company, not to a rep. invoice:read is the whole
  // of its access control, which is why the finance figures are gated on
  // seeFinance rather than narrowed by row.
  // TEMPORARY: per-call timings for an admin who adds ?timing=1.
  const timings: number[] = [];
  const pageStart = Date.now();
  const [caseScope, projectScope] = await Promise.all([
    scopeFilter(user, "ownerUserId"),
    scopeFilter(user, "projectManagerId"),
  ]);

  const [
    pipeline, commissions, openCases, activeProjects, overdueInvoices, topPartners, myActivities,
    summary, attentionData, payables, approvals, pulse, recentChanges, auditTypes,
    salesAnalytics, financeAnalytics, serviceAnalytics, partnerAnalytics, deliveryAnalytics,
  ] =
    await timedAll(timings, [
      // Each of these throws for a role without the matching permission, so the
      // gate has to be here as well as in the layout — an ungated call would
      // take the whole page down rather than omit one card.
      seeSales ? getPipelineByStage() : [],
      // Commissions are partner-facing and this throws for anyone without
      // commission:read, which took the whole dashboard down for Project
      // Managers and Consultants. Empty buckets render as a ledger of zeros,
      // and the panel is already gated on summary.visible.partners.
      getPartnerCommissionTotals().catch(() => ({
        currency: "PKR",
        openTotal: toDecimal(0),
        owedTotal: toDecimal(0),
        owedCount: 0,
        dueTotal: toDecimal(0),
        dueCount: 0,
        paidTotal: toDecimal(0),
        pendingRequests: 0,
      })),
      (async () => {
        if (!seeCases) return 0;
        const db = await supabaseServer();
        let query = db
          .from("support_case")
          .select("id", { count: "exact", head: true })
          .is("deletedAt", null)
          .not("status", "in", '("CLOSED","CANCELLED","RESOLVED")');
        query = applyScope(query, caseScope);
        const { count } = await query;
        return count ?? 0;
      })(),
      (async () => {
        if (!seeProjects) return 0;
        const db = await supabaseServer();
        let query = db
          .from("project")
          .select("id", { count: "exact", head: true })
          .is("deletedAt", null)
          .eq("status", "ACTIVE");
        query = applyScope(query, projectScope);
        const { count } = await query;
        return count ?? 0;
      })(),
      // PostgREST has no aggregate, so the overdue rows are fetched and summed.
      // The dueDate cut-off is passed as a date string, which is what the
      // column is — comparing in JS against an ISO string would be the trap
      // this migration keeps hitting.
      (async () => {
        if (!seeFinance) {
          return { _count: 0, _sum: { outstandingAmount: toDecimal(0) } };
        }
        const db = await supabaseServer();
        const { data } = await db
          .from("invoice")
          .select("outstandingAmount")
          .is("deletedAt", null)
          .not("status", "in", '("DRAFT","CANCELLED","PAID","WRITTEN_OFF")')
          .lt("dueDate", new Date().toISOString().slice(0, 10));
        const rows = data ?? [];
        return {
          _count: rows.length,
          _sum: {
            outstandingAmount: rows.reduce(
              (sum, r) => sum.plus(toDecimal(r.outstandingAmount)),
              toDecimal(0),
            ),
          },
        };
      })(),
      (async () => {
        if (!seePartners) return [];
        const db = await supabaseServer();
        const { data } = await db
          .from("partner")
          .select(
            `*,
             opportunities:opportunity!opportunity_sourcePartnerId_fkey ( count ),
             commissions:partner_commission ( partnerAmount, status )`,
          )
          .is("deletedAt", null)
          .eq("status", "ACTIVE")
          .limit(6);

        return (data ?? []).map((p: Record<string, any>) => ({
          ...p,
          _count: {
            opportunities:
              (p.opportunities as { count: number }[] | undefined)?.[0]?.count ?? 0,
          },
          // Rejected commission was never earned.
          commissions: ((p.commissions ?? []) as { status: string }[]).filter(
            (c) => c.status !== "REJECTED",
          ),
        }));
      })(),
      (async () => {
        const db = await supabaseServer();
        const { data } = await db
          .from("activity")
          .select("*")
          .eq("ownerUserId", user.id)
          .eq("status", "OPEN")
          .is("deletedAt", null)
          .order("dueAt")
          .limit(6);
        return data ?? [];
      })(),
      getModuleSummary(),
      getAttentionItems(),
      // Payables are finance-only, and this throws rather than returning empty
      // for anyone else — which took the whole dashboard down for every
      // OWN-scope sales role. The panel that consumes it is already behind
      // summary.visible.finance, so zeros here are never rendered.
      getPayablesSummary().catch(() => ({
        billsOutstanding: "0",
        billsOutstandingCount: 0,
        billsOverdue: "0",
        billsOverdueCount: 0,
        expensesAwaitingApproval: "0",
        expensesAwaitingApprovalCount: 0,
        expensesToPay: "0",
        expensesToPayCount: 0,
      })),
      // The queue needs at least one approve permission. A reader without any
      // gets an empty list rather than a page that fails to load.
      getPendingApprovals().catch(() => ({
        items: [] as Awaited<ReturnType<typeof getPendingApprovals>>["items"],
        byKind: {},
        totalValue: "0",
        oldestDays: 0,
      })),
      getPulse(30),
      getRecentChanges(25),
      getVisibleAuditTypes(),
      // The biggest open deals, for the sales view's ranked list. Scoped by the
      // caller's own client, so a rep sees their own deals ranked and a manager
      // sees the team's — the ranking answers "what should I chase", which is a
      // different question for each of them.
      // The four module analytics. Each returns empty for a reader without the
      // matching permission rather than throwing, so one missing permission
      // cannot take the whole dashboard down.
      //
      // Only the open tab's analytics are loaded: each one is a page's worth of
      // queries, and loading all five for the overview, which shows none of
      // them, made the dashboard the slowest screen in the app.
      seeSales && rangeParams.view === "sales" ? getSalesAnalytics() : Promise.resolve(null),
      seeFinance && rangeParams.view === "finance" ? getFinanceAnalytics() : Promise.resolve(null),
      seeCases && rangeParams.view === "service" ? getServiceAnalytics() : Promise.resolve(null),
      seePartners && rangeParams.view === "partners" ? getPartnerAnalytics() : Promise.resolve(null),
      // Null rather than a hand-written empty shape: the empty object had to be
      // updated every time the analytics gained a field, and forgetting was a
      // type error at best and a wrong zero at worst.
      seeProjects && rangeParams.view === "delivery" ? getDeliveryAnalytics(range, rangeParams) : Promise.resolve(null),
    ]);

  const openStages = pipeline.filter(
    (p) => p.stage !== "CLOSED_WON" && p.stage !== "CLOSED_LOST",
  );
  const openPipelineTotal = openStages.reduce(
    (s, p) => s.plus(p.total),
    toDecimal(0),
  );
  const wonTotal =
    pipeline.find((p: Record<string, any>) => p.stage === "CLOSED_WON")?.total ?? toDecimal(0);
  const maxStage = openStages.reduce(
    (m, p) => (p.total.greaterThan(m) ? p.total : m),
    toDecimal(1),
  );

  // Only the categories that actually have something in them, so an empty
  // strip disappears rather than reading as four reassuring zeros.
  const attention = [
    {
      count: attentionData.overdueInvoices.length,
      title: "Invoices past their due date",
      detail: attentionData.overdueInvoices
        .slice(0, 3)
        .map((i: Record<string, any>) => `${i.invoiceNumber}, ${i.account?.name ?? "unknown"}`)
        .join(" · "),
      href: "/invoices",
      tone: "danger" as const,
    },
    {
      count: attentionData.breachedCases.length,
      title: "Cases breaching SLA or marked critical",
      detail: attentionData.breachedCases
        .slice(0, 3)
        .map((c: Record<string, any>) => `${c.caseNumber}, ${c.subject}`)
        .join(" · "),
      href: "/cases",
      tone: "danger" as const,
    },
    {
      count: attentionData.staleDeals.length,
      title: "Deals past their expected close date",
      detail: attentionData.staleDeals
        .slice(0, 3)
        .map((o: Record<string, any>) => `${o.name}, ${o.account?.name ?? "unknown"}`)
        .join(" · "),
      href: "/opportunities",
      tone: "warning" as const,
    },
    {
      count: attentionData.expiringAgreements.length,
      title: "Partner agreements expiring within 60 days",
      detail: attentionData.expiringAgreements
        .slice(0, 3)
        .map((p: Record<string, any>) => `${p.displayName}, ${formatDate(p.agreementExpiryDate)}`)
        .join(" · "),
      href: "/partners",
      tone: "warning" as const,
    },
    {
      // Split from the general expiry list: an auto-renewing contract inside
      // its notice window is the one where doing nothing has a consequence, so
      // it gets its own line and the stronger tone.
      count: attentionData.expiringContracts.filter(
        (c: Record<string, any>) => c.autoRenews && c.inNoticeWindow,
      ).length,
      title: "Auto-renewing contracts inside their notice period",
      detail: attentionData.expiringContracts
        .filter((c: Record<string, any>) => c.autoRenews && c.inNoticeWindow)
        .slice(0, 3)
        .map((c: Record<string, any>) => `${c.name}, ${c.daysToEnd}d left`)
        .join(" · "),
      href: "/contracts",
      tone: "danger" as const,
    },
    {
      count: attentionData.expiringContracts.filter(
        (c: Record<string, any>) => !(c.autoRenews && c.inNoticeWindow),
      ).length,
      title: "Contracts ending within 90 days",
      detail: attentionData.expiringContracts
        .filter((c: Record<string, any>) => !(c.autoRenews && c.inNoticeWindow))
        .slice(0, 3)
        .map((c: Record<string, any>) => `${c.name}, ${formatDate(c.endDate)}`)
        .join(" · "),
      href: "/contracts",
      tone: "warning" as const,
    },
    {
      count: approvals.items.filter((i) => !i.blockedReason).length,
      title: "Waiting on your approval",
      detail: approvals.items
        .filter((i) => !i.blockedReason)
        .slice(0, 3)
        .map((i) => `${i.reference}, ${i.title}`)
        .join(" · "),
      href: "/approvals",
      tone: "warning" as const,
    },
  ].filter((item) => item.count > 0);

  const partnersRanked = topPartners
    .map((p: Record<string, any>) => ({
      ...p,
      earned: p.commissions.reduce(
        (s: ReturnType<typeof toDecimal>, r: Record<string, any>) =>
          s.plus(toDecimal(r.partnerAmount)),
        toDecimal(0),
      ),
    }))
    .sort((a, b) => b.earned.comparedTo(a.earned));

  const liveDeals = openStages.reduce(
    (s: number, p: Record<string, any>) => s + p.count,
    0,
  );

  /**
   * The headline row, built from what this reader may see rather than fixed at
   * four.
   *
   * A role gets the tiles for its own work: sales sees pipeline and wins,
   * finance sees cash in and cash overdue, delivery sees its projects and its
   * cases. Someone who clears none of them — a brand new account, or a role
   * scoped entirely to its own tasks — gets the two personal tiles at the end,
   * so the row is never empty.
   *
   * Zeros are not a safe fallback here. "Collected this month: PKR 0" reads as
   * a fact about the company, not as an absence of permission, and a consultant
   * who reported that upward would be repeating something untrue.
   */
  const tiles: React.ComponentProps<typeof PulseTile>[] = [];

  if (seeSales) {
    tiles.push({
      label: "Open pipeline",
      raw: Number(openPipelineTotal),
      sublabel: `${liveDeals} live deals`,
      series: pulse.dealsCreated.values,
      delta: pulse.deltas.dealsCreated,
      href: "/opportunities",
      icon: "Target",
      tone: "primary",
    });
    tiles.push({
      label: "Won this month",
      raw: Number(summary.sales.wonValueThisMonth),
      sublabel: `${summary.sales.wonThisMonth} deals closed`,
      series: pulse.wonValue.values,
      delta: pulse.deltas.wonValue,
      href: "/opportunities?stage=CLOSED_WON",
      icon: "TrendingUp",
      tone: "success",
    });
  }

  if (seeFinance) {
    tiles.push({
      label: "Collected this month",
      raw: Number(summary.finance.collectedThisMonth),
      sublabel: `${formatCompactMoney(summary.finance.outstanding)} still outstanding`,
      series: pulse.collected.values,
      delta: pulse.deltas.collected,
      href: "/payments",
      icon: "Banknote",
      tone: "success",
    });
    tiles.push({
      label: "Overdue receivables",
      raw: Number(overdueInvoices._sum.outstandingAmount ?? 0),
      sublabel: `${overdueInvoices._count} invoices past due`,
      // Cash collected, inverted in meaning rather than in data: money
      // arriving is what clears this figure, so the same series is the
      // honest trend for it. A sparkline of unrelated numbers under a
      // headline is worse than no sparkline.
      series: pulse.collected.values,
      delta: pulse.deltas.collected,
      href: "/invoices",
      icon: "Receipt",
      tone: overdueInvoices._count > 0 ? "danger" : "muted",
    });
  }

  if (seeProjects) {
    tiles.push({
      label: "Active projects",
      raw: activeProjects,
      format: "count",
      sublabel: `${summary.delivery.atRiskProjects} at risk`,
      delta: null,
      href: "/projects",
      icon: "FolderKanban",
      tone: summary.delivery.atRiskProjects > 0 ? "danger" : "primary",
    });
  }

  if (seeCases) {
    tiles.push({
      label: "Open support cases",
      raw: openCases,
      format: "count",
      sublabel: `${summary.service.criticalCases} critical`,
      delta: null,
      href: "/cases",
      icon: "LifeBuoy",
      tone: summary.service.criticalCases > 0 ? "danger" : "primary",
    });
  }

  // Personal tiles, so a narrowly scoped role still opens onto something that
  // is about their day rather than an empty strip.
  if (tiles.length < 4) {
    tiles.push({
      label: "My open activities",
      raw: myActivities.length,
      format: "count",
      sublabel: "scheduled for you",
      delta: null,
      href: "/my-work",
      icon: "CalendarCheck",
      tone: "muted",
    });
  }

  /**
   * Which view to render.
   *
   * Only views this reader may see are offered, using the same permission flags
   * the summary cards already compute — so a consultant is never shown a Finance
   * tab that would refuse them, and there is no second list of who sees what to
   * keep in step.
   *
   * An unknown value in the URL falls back to the overview rather than rendering
   * nothing: the parameter is user-editable, and a typo in a shared link should
   * not produce a blank screen.
   */
  const params = rangeParams;

  const views: { key: ViewKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...(summary.visible.sales ? [{ key: "sales" as const, label: "Sales" }] : []),
    ...(summary.visible.finance ? [{ key: "finance" as const, label: "Finance" }] : []),
    ...(summary.visible.delivery ? [{ key: "delivery" as const, label: "Delivery" }] : []),
    ...(summary.visible.service ? [{ key: "service" as const, label: "Support" }] : []),
    ...(summary.visible.partners ? [{ key: "partners" as const, label: "Partners" }] : []),
  ];

  const view: ViewKey = views.some((v) => v.key === params.view)
    ? (params.view as ViewKey)
    : "overview";

  return (
    <DashboardViewTransition>
      {rangeParams.timing === "1" && can(user, PERMISSIONS.ADMIN) && (
        <pre data-timing className="mb-4 rounded border p-2 text-xs">
          {JSON.stringify({
            total: Date.now() - pageStart,
            summarySource: (summary as { source?: string }).source ?? "queries",
            calls: [
              "pipeline", "commissions", "openCases", "activeProjects", "overdueInvoices", "topPartners", "myActivities",
              "summary", "attention", "payables", "approvals", "pulse", "recentChanges", "auditTypes",
              "sales", "finance", "service", "partners", "delivery",
            ].map((name, i) => `${name}:${timings[i]}`),
          })}
        </pre>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title={`Good to see you, ${user.fullName.split(" ")[0]}`}
          description="Pipeline, cash and delivery load - updating as it happens."
        />
        <div className="mb-4 flex items-center gap-3">
          <LiveClock />
          <LiveIndicator />
        </div>
      </div>

      {/* Only rendered when there is somewhere to switch to. A single tab is
          not a choice, and a tab strip that never changes anything is noise. */}
      {views.length > 1 && (
        <div className="mb-4">
          <DashboardViews views={views} active={view} />
        </div>
      )}

      <DashboardViewBody>
      {/* Below the view tabs rather than beside them: which part of the
          business you are looking at and over what period are two separate
          choices, and stacking them keeps either from crowding the other on a
          narrow screen. Only the Delivery view reads the range so far, so it is
          only offered there — a filter that changes nothing is worse than no
          filter. */}
      {view === "delivery" && deliveryAnalytics && (
        <div className="mb-6">
          <DeliveryFiltersBar range={range} options={deliveryAnalytics.filterOptions} />
        </div>
      )}

      {view === "sales" && salesAnalytics ? (
        <SalesView
          summary={summary}
          pulse={pulse}
          pipeline={pipeline}
          attention={{ staleDeals: attentionData.staleDeals }}
          analytics={salesAnalytics}
        />
      ) : view === "finance" && financeAnalytics ? (
        <FinanceView
          summary={summary}
          pulse={pulse}
          payables={payables}
          analytics={financeAnalytics}
        />
      ) : view === "delivery" && deliveryAnalytics ? (
        <DeliveryView
          analytics={deliveryAnalytics}
        />
      ) : view === "service" && serviceAnalytics ? (
        <ServiceView summary={summary} pulse={pulse} analytics={serviceAnalytics} />
      ) : view === "partners" && partnerAnalytics ? (
        <PartnersView analytics={partnerAnalytics} />
      ) : (
      <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <PulseTile key={tile.label} {...tile} />
        ))}
      </div>

      {attention.length > 0 && (
        <Card className="mt-6 border-amber-300/60 dark:border-amber-800/60">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
            <CardTitle className="text-base">Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="divide-y border-t">
              {attention.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                >
                  <span className="mt-0.5 shrink-0">
                    <Badge tone={item.tone}>{item.count}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{item.title}</span>
                    <span className="block text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="mb-3 mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        <PulseDot />
        Live summary
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {summary.visible.sales && (
          <ModuleSummary
            title="Sales"
            icon={Target}
            href="/opportunities"
            headline={{ label: "in open pipeline", value: formatCompactMoneyTotal(summary.sales.openValue) }}
            rows={[
              { label: "Open deals", value: String(summary.sales.openDeals), href: "/opportunities" },
              { label: "Won this month", value: `${summary.sales.wonThisMonth} · ${formatCompactMoneyTotal(summary.sales.wonValueThisMonth)}`, href: "/opportunities?stage=CLOSED_WON" },
              { label: "Quotes awaiting reply", value: `${summary.sales.quotesAwaitingReply} · ${formatCompactMoneyTotal(summary.sales.quoteValueOut)}`, href: "/quotations?status=SENT" },
              { label: "New leads", value: String(summary.sales.newLeads), href: "/leads?status=NEW" },
              { label: "Follow-ups due", value: String(summary.sales.leadsToFollowUp), href: "/leads", alert: summary.sales.leadsToFollowUp > 0 },
            ]}
          />
        )}

        {summary.visible.finance && (
          <ModuleSummary
            title="Finance"
            icon={Receipt}
            href="/invoices"
            headline={{ label: "outstanding", value: formatCompactMoneyTotal(summary.finance.outstanding) }}
            rows={[
              { label: "Overdue", value: `${summary.finance.overdueCount} · ${formatCompactMoneyTotal(summary.finance.overdue)}`, href: "/invoices", alert: summary.finance.overdueCount > 0 },
              { label: "Collected this month", value: formatCompactMoneyTotal(summary.finance.collectedThisMonth), href: "/payments" },
              { label: "Unallocated payments", value: formatCompactMoneyTotal(summary.finance.unallocatedPayments), href: "/payments", alert: Number(summary.finance.unallocatedPayments) > 0 },
              { label: "Draft invoices", value: String(summary.finance.draftInvoices), href: "/invoices" },
              // Payables belong here too: receivables alone say what was earned,
              // not what it cost.
              { label: "Owed to suppliers", value: formatCompactMoneyTotal(payables.billsOutstanding), href: "/vendor-bills" },
              {
                label: "Expenses to approve",
                value: String(payables.expensesAwaitingApprovalCount),
                href: "/expenses?approvalStatus=SUBMITTED",
                alert: payables.expensesAwaitingApprovalCount > 0,
              },
            ]}
          />
        )}

        {summary.visible.delivery && (
          <ModuleSummary
            title="Delivery"
            icon={FolderKanban}
            href="/projects"
            headline={{ label: "active projects", value: String(summary.delivery.activeProjects) }}
            rows={[
              { label: "At risk", value: String(summary.delivery.atRiskProjects), href: "/projects", alert: summary.delivery.atRiskProjects > 0 },
              { label: "Milestones due in 14 days", value: String(summary.delivery.milestonesDueSoon), href: "/projects" },
              { label: "Overdue tasks", value: String(summary.delivery.overdueTasks), href: "/projects", alert: summary.delivery.overdueTasks > 0 },
              { label: "Hours awaiting approval", value: summary.delivery.hoursAwaitingApproval, href: "/timesheets/approvals" },
            ]}
          />
        )}

        {summary.visible.service && (
          <ModuleSummary
            title="Support"
            icon={LifeBuoy}
            href="/cases"
            headline={{ label: "open cases", value: String(summary.service.openCases) }}
            rows={[
              { label: "Critical", value: String(summary.service.criticalCases), href: "/cases?priority=CRITICAL", alert: summary.service.criticalCases > 0 },
              { label: "SLA breached", value: String(summary.service.breachedSla), href: "/cases", alert: summary.service.breachedSla > 0 },
              { label: "Unassigned", value: String(summary.service.unassignedCases), href: "/cases", alert: summary.service.unassignedCases > 0 },
            ]}
          />
        )}

        {summary.visible.partners && (
          <ModuleSummary
            title="Partners"
            icon={Handshake}
            href="/partners"
            headline={{ label: "commission owed on won deals", value: formatCompactMoneyTotal(summary.partners.commissionPayable) }}
            rows={[
              { label: "Active partners", value: String(summary.partners.activePartners), href: "/partners" },
              { label: "Rate requests waiting", value: String(summary.partners.commissionPendingApproval), href: "/commissions?view=requests", alert: summary.partners.commissionPendingApproval > 0 },
              { label: "Agreements expiring in 60 days", value: String(summary.partners.agreementsExpiringSoon), href: "/partners", alert: summary.partners.agreementsExpiringSoon > 0 },
            ]}
          />
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {seeSales && (
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center gap-2">
            <CardTitle>Pipeline by stage</CardTitle>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {formatCompactMoneyTotal(openPipelineTotal)} / {liveDeals} deals
            </span>
          </CardHeader>
          <CardContent>
            {openStages.length === 0 ? (
              <EmptyState title="No open deals yet" description="Convert a lead or create an opportunity to get started." />
            ) : (
              <div className="space-y-2.5">
                {openStages.map((s: Record<string, any>) => {
                  const share = Number(s.total.dividedBy(maxStage).times(100));
                  return (
                    <Link
                      key={s.stage}
                      href={`/opportunities?stage=${s.stage}`}
                      className="group flex items-center gap-3 rounded px-1 py-0.5 -mx-1 transition-colors hover:bg-muted/50"
                    >
                      <span className="w-32 shrink-0 truncate font-mono text-[11px] uppercase tracking-wider text-muted-foreground sm:w-44">
                        {humanize(s.stage)}
                      </span>
                      <div className="h-6 flex-1 overflow-hidden rounded bg-muted">
                        <div
                          className="h-full rounded bg-gradient-to-r from-cyan-500/70 to-cyan-400 transition-all duration-500 group-hover:from-cyan-500 group-hover:to-cyan-300"
                          style={{ width: `${Math.max(2, share)}%` }}
                        />
                      </div>
                      <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums sm:w-28">
                        {formatCompactMoney(s.total)}
                      </span>
                      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:w-10">
                        {s.count}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        )}

        {/* Omitted rather than zeroed for a reader without commission access:
            a ledger of confident zeros reads as "no commission is owed", which
            is a different and possibly wrong statement. */}
        {summary.visible.partners && (
        <Card>
          <CardHeader>
            <CardTitle>Partner commission</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: "On open deals", note: "An estimate that follows each deal", amount: commissions.openTotal, href: "/commissions?view=open" },
              { label: "Owed on won deals", note: `${commissions.owedCount} to pay`, amount: commissions.owedTotal, href: "/commissions?view=owed" },
              { label: "Due now", note: `${commissions.dueCount} past their payment date`, amount: commissions.dueTotal, href: "/commissions?view=due" },
              { label: "Paid", note: "Marked paid", amount: commissions.paidTotal, href: "/commissions?view=paid" },
            ].map((row) => (
              <Link key={row.label} href={row.href} className="flex items-center justify-between border-b pb-2 last:border-0 hover:opacity-80">
                <div>
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-muted-foreground">{row.note}</p>
                </div>
                <span className="text-sm font-semibold tabular">
                  {formatMoney(row.amount, commissions.currency)}
                </span>
              </Link>
            ))}
            <Link href="/commissions" className="block pt-1 text-sm text-primary hover:underline">
              Open partner commission →
            </Link>
          </CardContent>
        </Card>
        )}
      </div>

      {/* Hidden outright for a reader who can see no module's history, rather
          than shown as an empty terminal - a blank log reads as "nothing is
          happening", which is a claim about the company and not about the
          reader's permissions. */}
      {auditTypes.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            <PulseDot />
            Change stream
            <span className="font-sans normal-case tracking-normal opacity-70">
              {/* Not "every edit anyone makes" any more: the stream is scoped to
                  the modules this reader can open, so promising the whole
                  company's activity would be a lie to most of them. */}
, edits across the modules you work in, as they land
            </span>
          </h2>
          <ActivityStream initial={recentChanges} visibleTypes={auditTypes} />
        </>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {seePartners && (
        <Card>
          <CardHeader>
            <CardTitle>Top partners by commission earned</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {partnersRanked.length === 0 ? (
              <div className="px-5">
                <EmptyState
                  title="No partners yet"
                  description="Add a reseller or an individual referrer to start tracking partner-sourced revenue."
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Partner</TH>
                    <TH>Type</TH>
                    <TH className="text-right">Deals</TH>
                    <TH className="text-right">Earned</TH>
                  </TR>
                </THead>
                <TBody>
                  {partnersRanked.map((p: Record<string, any>) => (
                    <TR key={p.id}>
                      <TD>
                        <Link href={`/partners/${p.id}`} className="font-medium hover:underline">
                          {p.displayName}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {p.kind === "INDIVIDUAL" ? "Individual" : "Company"}
                        </p>
                      </TD>
                      <TD>
                        <Badge tone="neutral">{humanize(p.partnerType)}</Badge>
                      </TD>
                      <TD className="text-right tabular">{p._count.opportunities}</TD>
                      <TD className="text-right font-medium tabular">{formatMoney(p.earned)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        )}

        {/* Open cases and active projects were a pair of tiles here as well as
            headline figures above. They are now in the headline row, where they
            are scoped and gated; repeating them under a different label was
            only ever noise. */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>My open activities</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {myActivities.length === 0 ? (
                <div className="px-5 pb-2 text-sm text-muted-foreground">Nothing scheduled. Enjoy it.</div>
              ) : (
                <ul className="divide-y">
                  {myActivities.map((a: Record<string, any>) => (
                    <li key={a.id} className="flex items-center justify-between px-5 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{a.subject}</p>
                        <p className="text-xs text-muted-foreground">
                          {humanize(a.activityType)} · due {formatDate(a.dueAt)}
                        </p>
                      </div>
                      <Badge tone={statusTone(a.priority)}>{humanize(a.priority)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      </>
      )}
      </DashboardViewBody>
    </DashboardViewTransition>
  );
}

// TEMPORARY: times each call in the dashboard's Promise.all, by position.
async function timedAll<T extends readonly unknown[]>(out: number[], items: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const start = Date.now();
  return Promise.all(
    items.map((item, i) => Promise.resolve(item).then((v) => { out[i] = Date.now() - start; return v; })),
  ) as never;
}
