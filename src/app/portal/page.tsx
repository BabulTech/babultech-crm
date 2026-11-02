import Link from "next/link";
import { MessageSquare } from "lucide-react";
import {
  getPortalSummary, getPartnerProfile, getPortalCommissions, getPortalAnalytics,
} from "@/server/portal";
import { countUnreadPartnerMessages } from "@/server/partner-activities";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, Button, Alert, Table, THead, TBody, TR, TH, TD, EmptyState,
} from "@/components/ui";
import { RankedList, AttentionList } from "@/components/dashboard-kit";
import { requireUser } from "@/lib/authz";
import { Sparkline, Delta } from "@/components/sparkline";
import { formatMoneyPlain as formatMoney, formatDate, formatPercent, humanize, daysBetween, formatMoneyTotal } from "@/lib/utils";

export default async function PortalHomePage() {
  const [summary, partner, recent, unread, stats] = await Promise.all([
    getPortalSummary(),
    getPartnerProfile(),
    getPortalCommissions(),
    countUnreadPartnerMessages(),
    getPortalAnalytics(),
  ]);
  // Commission is for the partner's Admins; a User sees the deals, not the money.
  const isAdmin = (await requireUser()).portalRole === "ADMIN";

  const agreementDays = partner.agreementExpiryDate
    ? daysBetween(new Date(), partner.agreementExpiryDate)
    : null;
  const expiringSoon = agreementDays !== null && agreementDays <= 60;

  return (
    <>
      <PageHeader
        title={`Welcome, ${partner.displayName}`}
        description="Your deals, what you have earned, and when it gets paid."
      >
        <Badge tone={statusTone(partner.status)}>{humanize(partner.status)}</Badge>
        <Badge tone="neutral">{humanize(partner.tier)}</Badge>
        {isAdmin && <Button asChild variant="outline"><Link href="/portal/account?edit=1">Update Profile</Link></Button>}
        <Button asChild variant="outline">
          <Link href="/portal/activities">
            <MessageSquare className="h-4 w-4" /> Contact babultech
            {unread > 0 && (
              <Badge tone="warning" className="ml-1.5">{unread}</Badge>
            )}
          </Link>
        </Button>
        <Button asChild>
          <Link href="/portal/customers/new">Add a customer</Link>
        </Button>
      </PageHeader>

      {partner.status !== "ACTIVE" && (
        <div className="mb-5">
          <Alert tone="warning">
            Your partnership is currently {humanize(partner.status).toLowerCase()}. New deals do not
            earn commission until it is active again - speak to your partner manager.
          </Alert>
        </div>
      )}
      {expiringSoon && agreementDays !== null && (
        <div className="mb-5">
          <Alert tone={agreementDays < 0 ? "danger" : "warning"}>
            {agreementDays < 0
              ? `Your partner agreement expired ${Math.abs(agreementDays)} day(s) ago.`
              : `Your partner agreement expires in ${agreementDays} day(s), on ${formatDate(partner.agreementExpiryDate)}.`}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isAdmin && (
        <>
        <StatTile
          label="Paid to you"
          value={formatMoneyTotal(summary.paidTotal, summary.currency)}
          sublabel="Net of withholding tax"
          tone="success"
        />
        <StatTile
          label="Owed to you"
          value={formatMoneyTotal(summary.owedTotal, summary.currency)}
          sublabel={summary.owedCount > 0 ? `On ${summary.owedCount} won deal(s), not yet paid` : "Nothing owed right now"}
          tone={summary.owedCount > 0 ? "warning" : "neutral"}
          href="/portal/commissions?status=IN_PROGRESS"
        />
        <StatTile
          label="In your pipeline"
          value={formatMoneyTotal(summary.pipelineTotal, summary.currency)}
          sublabel="Your commission on open deals, if they are won"
          tone="info"
        />
        </>
        )}
        <StatTile
          label="Your deals"
          value={String(summary.dealCount)}
          sublabel="Credited to you"
          href="/portal/deals"
        />
      </div>

      {/*
        Ordered by the question a partner asks first: how am I doing, then what
        is still in play, then what needs me to do something. Anything needing
        action comes last on purpose - it is the part they act on, so it sits
        closest to where they stop reading.
      */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {isAdmin && (
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>What you have earned</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Commission earned each month, over the last six months.
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-lg font-semibold tabular-nums">
                {formatMoneyTotal(stats.thisMonth, stats.currency)}
              </p>
              <p className="text-xs text-muted-foreground">this month</p>
              <Delta value={stats.monthDelta} />
            </div>
          </CardHeader>
          <CardContent>
            <Sparkline
              values={stats.months.map((m) => m.total)}
              tone="success"
              height={64}
              className="w-full"
            />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              {stats.months.map((m) => (
                <span key={m.key}>{m.label}</span>
              ))}
            </div>
          </CardContent>
        </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Your deals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {stats.winRate === null ? "—" : `${stats.winRate}%`}
              </p>
              <p className="text-muted-foreground">
                {stats.winRate === null
                  ? "No deals decided yet"
                  : `won — ${stats.wonCount} of ${stats.wonCount + stats.lostCount} decided`}
              </p>
            </div>
            <div className="border-t pt-3">
              <p className="font-mono text-lg font-semibold tabular-nums">
                {formatMoneyTotal(stats.openValue, stats.currency)}
              </p>
              <p className="text-muted-foreground">
                still open across {stats.openCount} deal(s)
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <RankedList
          title="Where your pipeline sits"
          module="partners"
          emptyText="No deals registered yet."
          rows={stats.stages.map((s) => ({
            id: s.stage,
            label: humanize(s.stage),
            sublabel: `${s.count} deal(s)`,
            value: s.value,
            display: formatMoney(s.value, stats.currency),
            href: `/portal/deals?stage=${s.stage}`,
          }))}
        />
        <RankedList
          title="Your best customers"
          module="partners"
          emptyText="Nothing won yet — this fills in as deals close."
          rows={stats.topAccounts.map((a) => ({
            id: a.id,
            label: a.name,
            value: a.value,
            display: formatMoney(a.value, stats.currency),
            href: `/portal/customers/${a.id}`,
          }))}
        />
      </div>

      {((isAdmin && stats.attention.paymentDue > 0) ||
        stats.attention.stale > 0 ||
        stats.attention.overdue > 0) && (
        <div className="mt-4">
          <h2 className="mb-2 text-sm font-semibold">Worth a look</h2>
          <AttentionList
            items={
              [
                isAdmin && stats.attention.paymentDue > 0 && {
                  id: "payment-due",
                  count: stats.attention.paymentDue,
                  title: "Commission past its payment date",
                  detail:
                    "Won, and due to be paid. If the money has reached you, mark it paid on your Commission page.",
                  href: "/portal/commissions?status=IN_PROGRESS",
                  tone: "warning" as const,
                },
                stats.attention.overdue > 0 && {
                  id: "overdue",
                  count: stats.attention.overdue,
                  title: "Past their expected close date",
                  detail: "Still open, but the date they were expected to land has gone.",
                  href: "/portal/deals",
                  tone: "warning" as const,
                },
                stats.attention.stale > 0 && {
                  id: "stale",
                  count: stats.attention.stale,
                  title: "No movement in 60 days",
                  detail: "Nothing has changed on these for two months.",
                  href: "/portal/deals",
                  tone: "warning" as const,
                },
              ].filter(Boolean) as Parameters<typeof AttentionList>[0]["items"]
            }
          />
        </div>
      )}

      {isAdmin && (
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Recent commission</CardTitle>
              <Button asChild variant="outline" size="sm">
                <Link href="/portal/commissions">See all</Link>
              </Button>
            </CardHeader>
            <CardContent className="px-0">
              {recent.length === 0 ? (
                <div className="px-5">
                  <EmptyState
                    title="Nothing earned yet"
                    description="Every deal credited to you gets a commission record the day it is created."
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Deal</TH>
                      <TH>Payment date</TH>
                      <TH className="text-right">You are paid</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {recent.slice(0, 8).map((r) => (
                      <TR key={r.id}>
                        <TD>
                          <span className="text-sm font-medium">{r.opportunity?.name}</span>
                          <p className="text-xs text-muted-foreground">
                            {r.opportunity?.account?.name}
                          </p>
                        </TD>
                        <TD className="whitespace-nowrap text-sm">
                          {r.paymentDate ? formatDate(r.paymentDate) : "When the deal is won"}
                        </TD>
                        <TD className="text-right font-medium tabular">
                          {formatMoney(r.partnerAmount, r.currencyCode)}
                        </TD>
                        <TD><Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>How you are paid</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your rate</p>
              <p className="mt-0.5">
                {formatPercent(partner.defaultCommissionPercent, 2)} of each deal&apos;s final amount,
                after discounts, tax included.
              </p>
            </div>
            {partner.withholdingTaxPercent ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Withholding tax
                </p>
                <p className="mt-0.5">
                  {formatPercent(partner.withholdingTaxPercent, 2)} of your commission is deducted
                  before payment.
                </p>
              </div>
            ) : null}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">When</p>
              <p className="mt-0.5">
                The payment date is set 90 days after a deal is won. A different rate on one deal can
                be requested from your Commission page.
              </p>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">
              You are paid in {partner.payoutCurrencyCode}.
            </p>
          </CardContent>
        </Card>
      </div>
      )}
    </>
  );
}
