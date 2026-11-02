import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, StatTile, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate, formatNumber, humanize } from "@/lib/utils";
import type { OverviewExtras } from "@/server/company-overview";

const pkr = (n: number) => `PKR ${formatNumber(Math.round(n), 0)}`;

export function HealthStrip({ health }: { health: OverviewExtras["health"] }) {
  const ok = health.lastEmailOutcome !== "FAILED";
  const items = [
    { label: "Email", value: ok ? "Working" : "Failing", note: `${health.emailFailed7d} failed in 7 days`, bad: !ok, href: "/activity-log?category=EMAIL" },
    { label: "Background jobs", value: String(health.jobsFailed7d), note: "failed in 7 days", bad: health.jobsFailed7d > 0, href: "/jobs" },
    { label: "Failed sign-ins", value: String(health.signInsFailed7d), note: "in 7 days", bad: false, href: "/activity-log?category=SIGN_IN&outcome=FAILED" },
  ];
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-3" data-testid="system-health">
      {items.map((i) => (
        <Link key={i.label} href={i.href} className="flex items-center justify-between rounded-md border p-3 text-sm hover:bg-muted">
          <span>{i.label} <span className="text-xs text-muted-foreground">{i.note}</span></span>
          <Badge tone={i.bad ? "danger" : "success"}>{i.value}</Badge>
        </Link>
      ))}
    </div>
  );
}

export function CashOutlook({ cash }: { cash: OverviewExtras["cash"] }) {
  const coming = cash.dueIn + cash.overdueIn;
  const going = cash.bills + cash.commissions + cash.expenses;
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Cash outlook, next 30 days</CardTitle>
        <p className="text-sm text-muted-foreground">
          From unpaid invoices ({pkr(cash.dueIn)} due, {pkr(cash.overdueIn)} already overdue) against vendor bills ({pkr(cash.bills)}), commissions ({pkr(cash.commissions)}) and approved expenses ({pkr(cash.expenses)}). Overdue money may not arrive. Salaries are not included.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Coming in" value={pkr(coming)} />
        <StatTile label="Going out" value={pkr(going)} />
        <StatTile label="Net" value={pkr(coming - going)} tone={coming - going < 0 ? "danger" : "success"} />
      </CardContent>
    </Card>
  );
}

const SERIES = [
  { key: "invoiced", label: "Invoiced" },
  { key: "collected", label: "Collected" },
  { key: "newPipeline", label: "New pipeline" },
] as const;

export function Trends({ trends }: { trends: OverviewExtras["trends"] }) {
  return (
    <Card className="mt-6">
      <CardHeader><CardTitle>Six-month trends</CardTitle></CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-3">
        {SERIES.map((s) => {
          const max = Math.max(1, ...trends.map((t) => t[s.key]));
          return (
            <div key={s.key}>
              <p className="mb-2 text-sm font-medium">{s.label}</p>
              <div className="flex h-28 items-end gap-2">
                {trends.map((t) => (
                  <div key={t.month} title={`${t.month}: ${pkr(t[s.key])}`} className="flex h-full flex-1 items-end">
                    <div className="w-full rounded-t bg-primary/70" style={{ height: `${Math.max(t[s.key] ? 2 : 0, (t[s.key] / max) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex gap-2 text-[10px] text-muted-foreground">
                {trends.map((t) => <span key={t.month} className="flex-1 text-center">{t.month.slice(0, 3)}</span>)}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function TimesheetCompliance({ data }: { data: OverviewExtras["timesheets"] }) {
  const committed = data.people.reduce((s, p) => s + Number(p.committed), 0);
  const logged = data.people.reduce((s, p) => s + Number(p.logged), 0);
  const submitted = data.people.filter((p) => p.status === "SUBMITTED" || p.status === "APPROVED").length;
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Utilisation and timesheets, week of {formatDate(data.weekStart)}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {formatNumber(logged, 1)} of {formatNumber(committed, 0)} committed hours ({committed ? formatNumber((logged / committed) * 100, 0) : 0}%). {submitted} of {data.people.length} submitted.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <THead><TR><TH>Person</TH><TH>Logged</TH><TH>Committed</TH><TH>Used</TH><TH>Timesheet</TH></TR></THead>
          <TBody>
            {data.people.map((p) => (
              <TR key={p.id}>
                <TD><Link href={`/timesheets/approvals?week=${data.weekStart}`} className="hover:underline">{p.name}</Link></TD>
                <TD className="tabular-nums">{formatNumber(Number(p.logged), 1)}</TD>
                <TD className="tabular-nums">{formatNumber(Number(p.committed), 0)}</TD>
                <TD className="tabular-nums">{Number(p.committed) ? `${formatNumber((Number(p.logged) / Number(p.committed)) * 100, 0)}%` : "—"}</TD>
                <TD><Badge tone={p.status === "APPROVED" ? "success" : p.status === "SUBMITTED" ? "info" : "warning"}>{p.status ? humanize(p.status) : "Not submitted"}</Badge></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
