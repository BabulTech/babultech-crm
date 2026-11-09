"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, Input, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { RichText } from "@/components/rich-text";
import { decideTimesheet, getTimesheetEntries, type TeamWeekRow } from "@/server/weekly-timesheets";

const STATUS: Record<TeamWeekRow["status"], { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  NOT_SUBMITTED: { label: "Not submitted", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  RETURNED: { label: "Returned", tone: "danger" },
};
const FILTERS = [
  ["all", "Everyone"],
  ["waiting", "Waiting for me"],
  ["behind", "Behind on hours"],
  ["not-submitted", "Not submitted"],
] as const;

type Entry = Awaited<ReturnType<typeof getTimesheetEntries>>[number];

function Row({ r, weekStart }: { r: TeamWeekRow; weekStart: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pct = r.committed ? Math.round((r.logged / r.committed) * 100) : 0;

  const toggle = () => {
    setOpen(!open);
    if (!entries) start(async () => setEntries(await getTimesheetEntries(r.userId, weekStart)));
  };
  const decide = (decision: "APPROVE" | "RETURN") => {
    setError(null);
    start(async () => {
      const res = await decideTimesheet(r.sheetId!, decision, remarks);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  };

  return (
    <>
      <TR data-person={r.fullName}>
        <TD>
          <button type="button" className="text-left font-medium text-primary hover:underline" onClick={toggle}>{r.fullName}</button>
          {r.rank === "CRM_ADMIN" && <p className="text-xs text-muted-foreground">CRM Admin</p>}
        </TD>
        <TD className="text-right">{r.committed}</TD>
        <TD className="text-right">
          <span className={r.logged < r.committed ? "text-amber-600" : ""}>{r.logged}</span>
          <span className="ml-1 text-xs text-muted-foreground">({pct}%)</span>
        </TD>
        <TD priority="secondary">
          <div className="flex items-end gap-2">
            {r.trend.map((t, i) => (
              <div key={t.weekStart} className="flex w-10 flex-col items-center" title={`Week of ${formatDate(t.weekStart)}: ${t.logged} of ${r.committed} hours`}>
                <div className="flex h-8 w-3 items-end rounded-sm bg-muted">
                  <div className={`w-full rounded-sm ${t.logged >= r.committed ? "bg-emerald-500" : "bg-amber-500"}`} style={{ height: `${Math.min(100, r.committed ? (t.logged / r.committed) * 100 : 0)}%` }} />
                </div>
                <span className={`text-xs ${i === 3 ? "font-semibold" : "text-muted-foreground"}`}>{t.logged}h</span>
                <span className="text-[10px] text-muted-foreground">{formatDate(t.weekStart).replace(/,? \d{4}$/, "")}</span>
              </div>
            ))}
          </div>
        </TD>
        <TD><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.decidedBy && <p className="text-xs text-muted-foreground">by {r.decidedBy}</p>}</TD>
        <TD>
          {r.status === "SUBMITTED" && r.canDecide && <Button size="sm" variant="outline" onClick={toggle}>{open ? "Close" : "Review"}</Button>}
          {r.status === "SUBMITTED" && !r.canDecide && <span className="text-xs text-muted-foreground">{r.rank === "CRM_ADMIN" ? "Super Admin approves" : ""}</span>}
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={6} className="bg-muted/30">
            <div className="space-y-3 py-2">
              {r.shortfallReason && <p className="text-sm"><span className="font-medium">Reason for the short week:</span> {r.shortfallReason}</p>}
              {r.remarks && <p className="text-sm"><span className="font-medium">Remarks:</span> {r.remarks}</p>}
              {!entries ? <p className="text-sm text-muted-foreground">Loading…</p> : entries.length === 0 ? <p className="text-sm text-muted-foreground">No time logged this week.</p> : (
                <ul className="space-y-1 text-sm">
                  {entries.map((e) => (
                    <li key={e.id} className="flex items-start gap-3">
                      <span className="w-24 shrink-0 text-muted-foreground">{formatDate(e.workDate)}</span>
                      <span className="w-12 shrink-0 text-right">{e.hours}h</span>
                      <span className="w-40 shrink-0 truncate">{e.on}</span>
                      <RichText value={e.description} className="min-w-0 flex-1 text-muted-foreground" />
                    </li>
                  ))}
                </ul>
              )}
              {error && <Alert tone="danger">{error}</Alert>}
              {r.status === "SUBMITTED" && r.canDecide && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label={`Remarks for ${r.fullName}`} className="max-w-md" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Remarks, e.g. Time is not complete (needed to return)" />
                  <Button size="sm" disabled={pending} onClick={() => decide("APPROVE")}>Approve</Button>
                  <Button size="sm" variant="outline" disabled={pending || remarks.trim().length < 3} onClick={() => decide("RETURN")}>Return with remarks</Button>
                </div>
              )}
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}

/** Who each filter shows. "Behind" in the current week means behind on the hours due so far. */
function matchesFilter(r: TeamWeekRow, show: string, dueFraction: number): boolean {
  return show === "waiting" ? r.status === "SUBMITTED" && r.canDecide
    : show === "behind" ? r.logged < r.committed * dueFraction
      : show === "not-submitted" ? r.status === "NOT_SUBMITTED" || r.status === "RETURNED"
        : true;
}

export function TeamTimesheets({ weekStart, prevWeek, nextWeek, thisWeek, isCurrent, weekLabel, weekRange, dueFraction, rows, show }: {
  weekStart: string; prevWeek: string; nextWeek: string; thisWeek: string; isCurrent: boolean; weekLabel: string | null; weekRange: string;
  dueFraction: number; rows: TeamWeekRow[]; show: string;
}) {
  const shown = rows.filter((r) => matchesFilter(r, show, dueFraction));
  const href = (week: string, s = show) => `/timesheets/approvals?week=${week}&show=${s}`;
  return (
    <Card>
      <CardContent className="space-y-4 px-0 pt-4">
        <div className="flex flex-wrap items-center gap-3 px-4">
          <Button asChild variant="outline" size="sm"><a href={href(prevWeek)}><ChevronLeft className="mr-1 h-4 w-4" />Previous week</a></Button>
          <div data-testid="week-banner" className="flex flex-1 flex-col items-center rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-center">
            {weekLabel && <span className="text-xs font-semibold uppercase tracking-wide text-primary">{weekLabel}</span>}
            <span className="text-base font-semibold text-foreground sm:text-lg">{weekRange}</span>
          </div>
          {!isCurrent && <Button asChild variant="outline" size="sm"><a href={href(thisWeek)}>This week</a></Button>}
          {!isCurrent && <Button asChild variant="outline" size="sm"><a href={href(nextWeek)}>Next week<ChevronRight className="ml-1 h-4 w-4" /></a></Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4">
          <span className="text-xs font-medium text-muted-foreground">Show:</span>
          {FILTERS.map(([k, label]) => (
            <Button key={k} asChild size="sm" variant={show === k ? "default" : "outline"}>
              <a href={href(weekStart, k)}>{label} ({rows.filter((r) => matchesFilter(r, k, dueFraction)).length})</a>
            </Button>
          ))}
        </div>
        {show === "behind" && dueFraction < 1 && <p className="px-4 text-xs text-muted-foreground">This week is not over: "behind" means fewer hours than due by today ({Math.round(dueFraction * 100)}% of the week's commitment).</p>}
        {shown.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">Nobody here for this week.</p> : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH className="text-right">Committed</TH>
                <TH className="text-right">Logged</TH>
                <TH priority="secondary">Last 4 weeks (hours)</TH>
                <TH>Status</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => <Fragment key={r.userId}><Row r={r} weekStart={weekStart} /></Fragment>)}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
