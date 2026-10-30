"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardContent, Button, Alert, Field,
  Badge, statusTone, StatTile, EmptyState,
} from "@/components/ui";
import { RichText } from "@/components/rich-text";
import { TimeEntryForm, type TimeEntryOptions } from "@/components/time-entry-form";
import { Sparkline } from "@/components/sparkline";
import { formatDate, formatNumber, humanize, cn } from "@/lib/utils";

/** Entries listed before "Show all". */
const ENTRIES_SHOWN = 10;

/**
 * A card whose body folds away. Open by default; the reader's choice is
 * remembered in this browser, per section.
 */
function Section({ id, title, subtitle, children }: { id: string; title: string; subtitle?: string; children: React.ReactNode }) {
  const key = `worklog.section.${id}`;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(key) === "closed") setOpen(false);
    } catch {
      /* Storage unavailable: stays open. */
    }
  }, [key]);
  function toggle() {
    setOpen((was) => {
      try {
        localStorage.setItem(key, was ? "closed" : "open");
      } catch {
        /* Not remembered, which is fine. */
      }
      return !was;
    });
  }
  return (
    <Card>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-start justify-between gap-3 p-5 text-left">
        <span>
          <span className="block text-base font-semibold">{title}</span>
          {subtitle && <span className="mt-1 block text-sm text-muted-foreground">{subtitle}</span>}
        </span>
        <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && <div className="pb-5">{children}</div>}
    </Card>
  );
}

interface Entry {
  id: string;
  workDate: string;
  hours: string;
  startTime: string | null;
  endTime: string | null;
  description: string;
  billable: boolean;
  approvalStatus: string;
  user: { id: string; fullName: string } | null;
  task: { id: string; name: string } | null;
}

export interface WorkLog {
  entries: Entry[];
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
  thisWeekHours: string;
  pendingApproval: number;
  byPerson: {
    userId: string;
    fullName: string;
    hours: string;
    billableHours: string;
    lastEntry: string | null;
  }[];
  daily: { date: string; hours: number }[];
}

/**
 * The project's daily work log: what people did, and what that adds up to.
 *
 * The project page showed "Hours logged 0.0" and nothing else — a total with
 * nothing behind it. The entries were in time_log all along; no screen ever
 * displayed them, so "what did anyone actually do on this project?" could not
 * be answered from the project.
 *
 * Logging comes first, because that is what most people open this tab to do:
 * "Log work" opens the form at the top, with the latest entries right under
 * it so what is already recorded can be checked while adding more. The
 * figures, the 30-day trend and the hours by person follow in a Summary.
 * Entries and Summary each fold away, open by default.
 *
 * Logging happens here rather than only on the Timesheets screen. Someone who
 * has the project open and wants to record an hour against it should not have
 * to navigate away, find the right week and pick the project back out of a
 * list. It calls the same `logTime` action the timesheet uses, so approval,
 * billing rates and the weekly submission all behave identically — this is a
 * second door onto one process, not a second process.
 */
export function WorkLogPanel({
  projectId,
  log,
  options,
  approvedHours,
  canLog,
}: {
  projectId: string;
  log: WorkLog;
  /** What this person can log time on; the form is locked to this project. */
  options: TimeEntryOptions;
  /** The project's approved budget, for the burn figure. Null when unbudgeted. */
  approvedHours: number | null;
  canLog: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const total = Number(log.totalHours);
  const billable = Number(log.billableHours);
  const nonBillable = Number(log.nonBillableHours);
  const billablePercent = total > 0 ? (billable / total) * 100 : 0;

  const burnPercent =
    approvedHours && approvedHours > 0 ? (total / approvedHours) * 100 : null;
  const overBudget = burnPercent !== null && burnPercent > 100;

  const shownEntries = showAll ? log.entries : log.entries.slice(0, ENTRIES_SHOWN);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- log work, first */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {formatNumber(total, 1)}h logged · {formatNumber(Number(log.thisWeekHours), 1)}h this week
        </p>
        {canLog && (
          <Button type="button" onClick={() => setAdding(!adding)}>
            {adding ? "Cancel" : <><Plus className="h-4 w-4" /> Log work</>}
          </Button>
        )}
      </div>

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>Log work</CardTitle>
          </CardHeader>
          <CardContent>
            {/* The same form as My timesheet, so an entry looks and behaves
                the same whichever door it came through. A full reload after
                saving, because router.refresh() did not take effect on the
                live build; the tab is kept in the address. */}
            <TimeEntryForm options={options} lockProjectId={projectId}
              onSaved={() => window.location.reload()} onCancel={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}

      {/* ------------------------------------- the log, right under the form */}
      <Section
        id="entries"
        title={`Entries (${log.entries.length})`}
        subtitle="Newest first. Rejected entries stay visible so whoever logged them can see what happened."
      >
        {log.entries.length === 0 ? (
          <div className="px-5">
            <EmptyState
              title="Nothing logged yet"
              description="Use “Log work” above to record the first day."
            />
          </div>
        ) : (
          <>
            <ul className="divide-y border-t">
              {shownEntries.map((e) => (
                <li
                  key={e.id}
                  className={cn(
                    "flex items-start gap-3 px-5 py-3",
                    e.approvalStatus === "REJECTED" && "opacity-60",
                  )}
                >
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">
                    {formatDate(e.workDate)}
                    {/* Only when recorded - an entry logged as a duration shows
                        the date alone rather than an empty range. */}
                    {e.startTime && e.endTime && (
                      <span className="block">
                        {e.startTime.slice(0, 5)}–{e.endTime.slice(0, 5)}
                      </span>
                    )}
                  </span>
                  <span className="w-14 shrink-0 text-sm font-medium tabular-nums">
                    {formatNumber(Number(e.hours), 2)}h
                  </span>
                  <span className="min-w-0 flex-1">
                    <RichText value={e.description} />
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {e.user?.fullName ?? "Unknown"}
                      {e.task && (
                        <>
                          {" · "}
                          <Link
                            href={`/projects/${projectId}/tasks/${e.task.id}`}
                            className="hover:underline"
                          >
                            {e.task.name}
                          </Link>
                        </>
                      )}
                      {!e.billable && " · non-billable"}
                    </span>
                  </span>
                  {/* Draft and approved are the unremarkable states; only the
                      ones needing attention get a badge. */}
                  {e.approvalStatus !== "APPROVED" && e.approvalStatus !== "DRAFT" && (
                    <Badge tone={statusTone(e.approvalStatus)}>
                      {humanize(e.approvalStatus)}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {log.entries.length > ENTRIES_SHOWN && (
              <div className="border-t px-5 pt-3">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Show the latest only" : `Show all ${log.entries.length}`}
                </Button>
              </div>
            )}
          </>
        )}
      </Section>

      {/* ------------------------------------------------------------- summary */}
      <Section id="summary" title="Summary" subtitle="Totals, the last 30 days, and who is carrying the work.">
        <div className="space-y-6 px-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Hours logged"
          help="Every approved and pending entry on this project. Rejected time is excluded - it was disputed and thrown out, so counting it would overstate the effort."
          value={formatNumber(total, 1)}
          sublabel={`${formatNumber(Number(log.thisWeekHours), 1)} this week`}
        />
        <StatTile
          label="Billable"
          help="Hours you can invoice, against hours you cannot. This ratio is the project's margin before any cost is counted."
          value={`${formatNumber(billablePercent, 0)}%`}
          sublabel={`${formatNumber(billable, 1)} billable · ${formatNumber(nonBillable, 1)} not`}
          tone={billablePercent >= 70 ? "success" : billablePercent >= 40 ? "warning" : "danger"}
        />
        <StatTile
          label="Budget used"
          help="Logged hours against the approved budget. Over 100% means the engagement is running past what was agreed - raise a change request rather than absorbing it."
          value={burnPercent === null ? "—" : `${formatNumber(burnPercent, 0)}%`}
          sublabel={
            approvedHours
              ? `${formatNumber(total, 1)} of ${formatNumber(approvedHours, 1)}`
              : "No budget set"
          }
          tone={overBudget ? "danger" : burnPercent !== null && burnPercent > 80 ? "warning" : "neutral"}
        />
        <StatTile
          label="Awaiting approval"
          help="Entries submitted but not yet approved. Unapproved time cannot be invoiced, so a growing number here is revenue sitting still."
          value={String(log.pendingApproval)}
          sublabel={log.pendingApproval > 0 ? "Not yet invoiceable" : "Nothing pending"}
          tone={log.pendingApproval > 0 ? "warning" : "neutral"}
        />
      </div>

      {/* --------------------------------------------------------- daily trend */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Daily hours</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              The last 30 days. Every day is plotted, so a gap in the work shows
              as a gap in the line rather than being closed up.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {log.daily.every((d) => d.hours === 0) ? (
            <EmptyState
              title="No time logged yet"
              description="Once someone records a day's work it appears here, and the figures above start to mean something."
            />
          ) : (
            <>
              <Sparkline
                values={log.daily.map((d) => d.hours)}
                height={64}
                tone={overBudget ? "danger" : "primary"}
                className="w-full"
              />
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{formatDate(log.daily[0]?.date)}</span>
                <span>{formatDate(log.daily[log.daily.length - 1]?.date)}</span>
              </div>
            </>
          )}

        </CardContent>
      </Card>

      {/* -------------------------------------------------------- who did what */}
      {log.byPerson.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Hours by person</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Who is carrying this project, and when they last touched it.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {log.byPerson.map((p) => {
              const share = total > 0 ? (Number(p.hours) / total) * 100 : 0;
              return (
                <div key={p.userId} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">{p.fullName}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatNumber(Number(p.hours), 1)}h
                      <span className="ml-2 text-xs">
                        {p.lastEntry ? `last ${formatDate(p.lastEntry)}` : ""}
                      </span>
                    </span>
                  </div>
                  {/* A bar rather than a number alone: relative contribution is
                      the thing being read, and a bar answers it without
                      arithmetic. */}
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

        </div>
      </Section>
    </div>
  );
}
