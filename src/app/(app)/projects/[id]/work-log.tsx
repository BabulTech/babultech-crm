"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardContent, Button, Alert, Field,
  Input, Select, Textarea, Badge, statusTone, StatTile, EmptyState,
} from "@/components/ui";
import { Sparkline } from "@/components/sparkline";
import { logProjectDay } from "@/server/timesheets";
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

/** Client-only counter for line keys; never persisted. */
let lineSeq = 0;

/**
 * One row of the day's work: a task, the hours on it, and what was done.
 *
 * `key` is a client-only id for React's list reconciliation. Using the array
 * index instead would make deleting a middle row re-key every row after it,
 * which throws away the text already typed into them.
 *
 * Declared at module scope rather than inside the component: the lazy
 * useState initialiser below runs on the first render, so a `const blankLine`
 * defined further down the component body would still be in its temporal dead
 * zone at that moment and throw.
 */
type Line = {
  key: string;
  projectTaskId: string;
  hours: string;
  description: string;
  billable: boolean;
  completeTask: boolean;
};

const blankLine = (): Line => ({
  key: `l${lineSeq++}`,
  projectTaskId: "",
  hours: "",
  description: "",
  billable: false,
  completeTask: false,
});

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
  tasks,
  approvedHours,
  canLog,
}: {
  projectId: string;
  log: WorkLog;
  tasks: { id: string; name: string }[];
  /** The project's approved budget, for the burn figure. Null when unbudgeted. */
  approvedHours: number | null;
  canLog: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);

  const total = Number(log.totalHours);
  const billable = Number(log.billableHours);
  const nonBillable = Number(log.nonBillableHours);
  const billablePercent = total > 0 ? (billable / total) * 100 : 0;

  const burnPercent =
    approvedHours && approvedHours > 0 ? (total / approvedHours) * 100 : null;
  const overBudget = burnPercent !== null && burnPercent > 100;

  const dayTotal = lines.reduce((sum, l) => sum + (Number(l.hours) || 0), 0);
  const completing = lines.filter((l) => l.completeTask && l.projectTaskId).length;

  function setLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit(formData: FormData) {
    setError(null);

    const filled = lines.filter((l) => l.hours || l.description);
    if (filled.length === 0) {
      setError("Add at least one line before saving.");
      return;
    }

    start(async () => {
      const result = await logProjectDay({
        projectId,
        workDate: String(formData.get("workDate")) as never,
        lines: filled.map((l) => ({
          projectTaskId: l.projectTaskId || null,
          hours: l.hours as never,
          description: l.description,
          billable: l.billable,
          completeTask: l.completeTask,
        })),
      } as never);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // A full reload rather than router.refresh(), which did not take effect
      // on the live build, so a saved entry did not appear. The tab is kept in
      // the address, so the reload lands back here.
      window.location.reload();
    });
  }

  const shownEntries = showAll ? log.entries : log.entries.slice(0, ENTRIES_SHOWN);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- log work, first */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {formatNumber(total, 1)}h logged · {formatNumber(Number(log.thisWeekHours), 1)}h this week
        </p>
        {canLog && (
          <Button type="button" onClick={() => { setAdding(!adding); setError(null); }}>
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
            <form action={submit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}

              <div className="flex flex-wrap items-end gap-4">
                <Field label="Date" required
                  help="The day the work happened, not the day you are recording it. Every line below belongs to this date.">
                  <Input
                    name="workDate"
                    type="date"
                    required
                    autoFocus
                    className="w-44"
                    // Today by default, because that is the answer nine times
                    // out of ten. Future dates are refused.
                    defaultValue={new Date().toISOString().slice(0, 10)}
                    max={new Date().toISOString().slice(0, 10)}
                  />
                </Field>

                {/* The running total sits beside the date rather than under the
                    last line: it is the number someone checks before saving,
                    and at the bottom of a four-line form it would be below the
                    fold on a laptop. */}
                <div className="pb-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Day total
                  </p>
                  <p className={cn(
                    "text-lg font-semibold tabular-nums",
                    dayTotal > 24 && "text-destructive",
                  )}>
                    {formatNumber(dayTotal, 2)}h
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {lines.map((line, i) => (
                  <div key={line.key} className="rounded-md border bg-muted/20 p-3">
                    <div className="grid gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-5">
                        <label className="text-xs font-medium text-muted-foreground">
                          Task
                        </label>
                        <Select
                          value={line.projectTaskId}
                          onChange={(e) => setLine(line.key, { projectTaskId: e.target.value })}
                          className="mt-1"
                        >
                          <option value="">The project generally</option>
                          {tasks.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </Select>
                      </div>

                      <div className="sm:col-span-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          Hours
                        </label>
                        <Input
                          type="number"
                          step="0.25"
                          min="0.25"
                          max="24"
                          value={line.hours}
                          onChange={(e) => setLine(line.key, { hours: e.target.value })}
                          placeholder="2"
                          className="mt-1"
                        />
                      </div>

                      <div className="sm:col-span-5">
                        <label className="text-xs font-medium text-muted-foreground">
                          What you did
                        </label>
                        <Input
                          value={line.description}
                          onChange={(e) => setLine(line.key, { description: e.target.value })}
                          placeholder="Fixed the duplicate-receipt bug"
                          className="mt-1"
                        />
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={line.billable}
                          onChange={(e) => setLine(line.key, { billable: e.target.checked })}
                          className="h-3.5 w-3.5 rounded border-input"
                        />
                        Billable
                      </label>

                      {/* Only offered on a line that names a task - "mark the
                          project generally as complete" is not a thing. */}
                      {line.projectTaskId && (
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={line.completeTask}
                            onChange={(e) => setLine(line.key, { completeTask: e.target.checked })}
                            className="h-3.5 w-3.5 rounded border-input"
                          />
                          Mark this task complete
                        </label>
                      )}

                      {lines.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                          aria-label={`Remove line ${i + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, blankLine()])}
              >
                <Plus className="h-4 w-4" /> Add another task
              </Button>

              <div className="flex items-center gap-3 border-t pt-4">
                <Button type="submit" disabled={pending || dayTotal > 24}>
                  {pending
                    ? "Saving…"
                    : `Save ${lines.filter((l) => l.hours || l.description).length} entr${
                        lines.filter((l) => l.hours || l.description).length === 1 ? "y" : "ies"
                      }`}
                </Button>
                <Button type="button" variant="outline"
                  onClick={() => { setAdding(false); setError(null); setLines([blankLine()]); }}>
                  Cancel
                </Button>

                {completing > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {completing} task{completing === 1 ? "" : "s"} will be marked complete.
                  </p>
                )}
                {dayTotal > 24 && (
                  <p className="text-xs text-destructive">
                    That is more than 24 hours in one day.
                  </p>
                )}
              </div>
            </form>
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
                    <span className="block text-sm">{e.description}</span>
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
