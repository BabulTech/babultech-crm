import Link from "next/link";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardContent, CardHeader, CardTitle, StatTile, Button, Forbidden, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate, formatNumber, humanize } from "@/lib/utils";
import { getCompanyOverview } from "@/server/company-overview";

/**
 * The whole business on one screen, for the Super Admin and CRM Admins:
 * headline figures against the previous period, the funnel from prospect to
 * payment, sales, delivery, money, the team and what needs a decision.
 */

type Params = { range?: string };

const RANGES = [
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-90", label: "Last 90 days" },
] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The chosen period as dates, in Pakistan time. */
function period(key: string): { from: string; to: string } {
  const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())}T00:00:00Z`);
  const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
  const monday = add(today, -((today.getUTCDay() + 6) % 7));
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  switch (key) {
    case "this-week": return { from: iso(monday), to: iso(today) };
    case "last-week": return { from: iso(add(monday, -7)), to: iso(add(monday, -1)) };
    case "last-month": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case "this-quarter": return { from: iso(new Date(Date.UTC(y, m - (m % 3), 1))), to: iso(today) };
    case "last-90": return { from: iso(add(today, -89)), to: iso(today) };
    default: return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) };
  }
}

const pkr = (n: number) => `PKR ${formatNumber(Math.round(n), 0)}`;
const pkrShort = (n: number) => (Math.abs(n) >= 1e6 ? `PKR ${formatNumber(n / 1e6, 1)}M` : Math.abs(n) >= 1e3 ? `PKR ${formatNumber(n / 1e3, 0)}K` : pkr(n));

/** "up 12% on the previous period", or a plain note when there is nothing to compare. */
function trend(now: number, before: number): { text: string; tone: "success" | "danger" | "neutral" } {
  if (!before) return { text: now ? "nothing in the previous period" : "same as the previous period", tone: "neutral" };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: "same as the previous period", tone: "neutral" };
  return { text: `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the previous period`, tone: pct > 0 ? "success" : "danger" };
}

export default async function CompanyOverviewPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="the Company overview" />;
  const q = await searchParams;
  const range = RANGES.some((r) => r.key === q.range) ? q.range! : "this-month";
  const { from, to } = period(range);
  const o = await getCompanyOverview(from, to);
  const c = o.current, p = o.previous;

  const tiles: { label: string; value: string; now: number; before: number; good?: "down"; href?: string }[] = [
    { label: "Outreach calls and emails", value: formatNumber(c.outreachTouches, 0), now: c.outreachTouches, before: p.outreachTouches, href: "/prospects/analytics" },
    { label: "Prospects qualified", value: formatNumber(c.prospectsQualified, 0), now: c.prospectsQualified, before: p.prospectsQualified, href: "/prospects?status=QUALIFIED" },
    { label: "New leads", value: formatNumber(c.leadsCreated, 0), now: c.leadsCreated, before: p.leadsCreated, href: "/leads" },
    { label: "Deals won", value: pkrShort(c.dealsWonValue), now: c.dealsWonValue, before: p.dealsWonValue, href: "/opportunities" },
    { label: "Invoiced", value: pkrShort(c.invoiced), now: c.invoiced, before: p.invoiced, href: "/invoices" },
    { label: "Collected", value: pkrShort(c.collected), now: c.collected, before: p.collected, href: "/payments" },
    { label: "Expenses", value: pkrShort(c.expenses), now: c.expenses, before: p.expenses, good: "down", href: "/expenses" },
    { label: "Hours logged", value: formatNumber(c.hoursLogged, 0), now: c.hoursLogged, before: p.hoursLogged, href: "/timesheets" },
  ];

  const f = o.funnel;
  const funnel = [
    { label: "Prospects added", n: f.prospectsAdded },
    { label: "Prospects worked", n: f.prospectsWorked },
    { label: "Qualified", n: f.qualified },
    { label: "New leads", n: f.leads },
    { label: "New deals", n: f.deals },
    { label: "Deals won", n: f.won },
    { label: "Invoices issued", n: f.invoiced },
    { label: "Invoices paid", n: f.paid },
  ];
  const maxFunnel = Math.max(1, ...funnel.map((s) => s.n));
  const won = c.dealsWon, lost = c.dealsLost;
  const a = o.attention;
  const attention = [
    { label: "Approvals waiting", n: a.approvals, href: "/approvals" },
    { label: "Support cases past their deadline", n: a.casesBreached, href: "/cases" },
    { label: "Invoices overdue", n: a.overdueInvoices, href: "/invoices" },
    { label: "Deals past their close date", n: a.dealsPastClose, href: "/opportunities" },
    { label: "Contracts ending within 60 days", n: a.contractsExpiring, href: "/accounts/renewals" },
    { label: "Leads untouched for 7+ days", n: a.staleLeads, href: "/leads" },
  ];
  const aging = o.money.aging;
  const agingRows = [
    { label: "Not yet due", v: aging.current },
    { label: "1 to 30 days late", v: aging.d1_30 },
    { label: "31 to 60 days late", v: aging.d31_60 },
    { label: "Over 60 days late", v: aging.d61 },
  ];
  const maxAging = Math.max(1, ...agingRows.map((r) => r.v));
  const healthTone = (h: string | null) => (h === "RED" ? "danger" : h === "AMBER" ? "warning" : "success") as "danger" | "warning" | "success";

  return (
    <>
      <PageHeader
        title="Company overview"
        description={`The whole business from ${formatDate(o.period.from)} to ${formatDate(o.period.to)}, compared with ${formatDate(o.period.previousFrom)} to ${formatDate(o.period.previousTo)}. Money is in PKR.`}
      >
        {RANGES.map((r) => (
          // Plain links: a client-side change of only the query string did not take effect on the production build.
          <Button key={r.key} asChild size="sm" variant={range === r.key ? "default" : "outline"}><a href={`/overview?range=${r.key}`}>{r.label}</a></Button>
        ))}
      </PageHeader>

      <Card>
        <CardHeader><CardTitle>Needs your decision</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {attention.map((x) => (
            <Link key={x.label} href={x.href} className="flex items-center justify-between rounded-md border p-3 text-sm hover:bg-muted">
              <span>{x.label}</span>
              <Badge tone={x.n ? "warning" : "success"}>{formatNumber(x.n, 0)}</Badge>
            </Link>
          ))}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => {
          const tr = trend(t.now, t.before);
          const tone = t.good === "down" && tr.tone !== "neutral" ? (tr.tone === "success" ? "danger" : "success") : tr.tone;
          return <StatTile key={t.label} label={t.label} value={t.value} sublabel={tr.text} tone={tone} href={t.href} />;
        })}
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>From prospect to payment</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {funnel.map((s, i) => (
            <div key={s.label} className="flex items-center gap-3 text-sm">
              <span className="w-36 shrink-0">{s.label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(s.n ? 1 : 0, (s.n / maxFunnel) * 100)}%` }} />
              </div>
              <span className="w-40 shrink-0 text-right tabular-nums">
                {formatNumber(s.n, 0)}
                {i > 0 && funnel[i - 1].n > 0 && <span className="ml-1 text-xs text-muted-foreground">({formatNumber((s.n / funnel[i - 1].n) * 100, 0)}%)</span>}
              </span>
            </div>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">Counts within the period; each percentage is of the step above.</p>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Sales</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Open pipeline" value={pkrShort(o.sales.pipelineValue)} sublabel={`${formatNumber(o.sales.openDeals, 0)} deals`} />
              <StatTile label="Closing this month" value={pkrShort(o.sales.closingThisMonthValue)} sublabel={`${formatNumber(o.sales.closingThisMonth, 0)} deals`} />
              <StatTile label="Win rate" value={won + lost ? `${formatNumber((won / (won + lost)) * 100, 0)}%` : "—"} sublabel={`${won} won, ${lost} lost`} />
            </div>
            {o.sales.byStage.length > 0 && (
              <Table>
                <THead><TR><TH>Stage</TH><TH>Deals</TH><TH>Value</TH></TR></THead>
                <TBody>
                  {o.sales.byStage.map((s) => <TR key={s.stage}><TD>{humanize(s.stage)}</TD><TD className="tabular-nums">{s.count}</TD><TD className="tabular-nums">{pkr(s.value)}</TD></TR>)}
                </TBody>
              </Table>
            )}
            {o.sales.topDeals.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Largest open deals</p>
                {o.sales.topDeals.map((d) => (
                  <Link key={d.id} href={`/opportunities/${d.id}`} className="flex justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                    <span className="truncate">{d.name} <span className="text-xs text-muted-foreground">{humanize(d.stage)}{d.closeDate ? `, close ${formatDate(d.closeDate)}` : ""}</span></span>
                    <span className="tabular-nums">{pkr(d.value)}</span>
                  </Link>
                ))}
              </div>
            ) : <p className="text-sm text-muted-foreground">No open deals.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Money</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <StatTile label="Outstanding" value={pkrShort(o.money.outstanding)} />
              <StatTile label="Overdue" value={pkrShort(o.money.overdueValue)} sublabel={`${o.money.overdueCount} invoices`} tone={o.money.overdueCount ? "danger" : "success"} />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Unpaid invoices by age</p>
              {agingRows.map((r) => (
                <div key={r.label} className="flex items-center gap-3 text-sm">
                  <span className="w-36 shrink-0">{r.label}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.v / maxAging) * 100}%` }} />
                  </div>
                  <span className="w-32 shrink-0 text-right tabular-nums">{pkr(r.v)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
          <p className="text-sm text-muted-foreground">
            {o.delivery.activeProjects} active projects: {o.delivery.byHealth.GREEN} green, {o.delivery.byHealth.AMBER} amber, {o.delivery.byHealth.RED} red · {o.delivery.overdueTasks} tasks overdue
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead><TR><TH>Project</TH><TH>Health</TH><TH>Hours used</TH><TH>Done</TH><TH>Overdue tasks</TH><TH priority="secondary">Margin</TH></TR></THead>
            <TBody>
              {o.delivery.projects.map((pr) => (
                <TR key={pr.id}>
                  <TD><Link href={`/projects/${pr.id}`} className="font-medium hover:underline">{pr.name}</Link><p className="text-xs text-muted-foreground">{pr.number} · {humanize(pr.status)}</p></TD>
                  <TD><Badge tone={healthTone(pr.health)}>{humanize(pr.health ?? "GREEN")}</Badge></TD>
                  <TD className="tabular-nums">{formatNumber(pr.logged, 1)}{pr.approvedHours ? ` of ${formatNumber(pr.approvedHours, 0)}` : ""}</TD>
                  <TD className="tabular-nums">{pr.completion != null ? `${formatNumber(pr.completion, 0)}%` : "—"}</TD>
                  <TD className={`tabular-nums ${pr.overdueTasks ? "text-destructive" : ""}`}>{pr.overdueTasks}</TD>
                  <TD priority="secondary" className="tabular-nums">{pkr(pr.margin)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Team in this period</CardTitle></CardHeader>
          <CardContent className="p-0">
            {o.team.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Nothing logged in this period.</p> : (
              <Table>
                <THead><TR><TH>Person</TH><TH>Outreach</TH><TH>Qualified</TH><TH>Deals won</TH><TH>Hours</TH></TR></THead>
                <TBody>
                  {o.team.map((t) => (
                    <TR key={t.id}>
                      <TD><Link href={`/users/${t.id}`} className="hover:underline">{t.name}</Link></TD>
                      <TD className="tabular-nums">{t.touches}</TD>
                      <TD className="tabular-nums">{t.qualified}</TD>
                      <TD className="tabular-nums">{t.won}</TD>
                      <TD className="tabular-nums">{formatNumber(t.hours, 1)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>This week&apos;s workload</CardTitle><p className="text-sm text-muted-foreground">Hours logged since Monday, against a 40-hour week.</p></CardHeader>
          <CardContent className="space-y-2">
            {o.delivery.workload.length === 0 ? <p className="text-sm text-muted-foreground">No time logged yet this week.</p> : o.delivery.workload.map((w) => (
              <div key={w.id} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 truncate">{w.name}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${w.weekHours > 40 ? "bg-destructive/70" : "bg-primary/70"}`} style={{ width: `${Math.min(100, (w.weekHours / 40) * 100)}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right tabular-nums">{formatNumber(w.weekHours, 1)} h</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
