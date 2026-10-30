"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { deleteTimeLog } from "@/server/timesheets";
import { findOverlaps } from "@/lib/work-hours";
import { Button, Card, CardContent, CardHeader, CardTitle, Alert, Badge, statusTone } from "@/components/ui";
import { RichText } from "@/components/rich-text";
import { TimeEntryForm, clockValue, type EditableTimeEntry, type TimeEntryOptions } from "@/components/time-entry-form";
import { cn, formatDate, formatNumber, humanize } from "@/lib/utils";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface Entry extends EditableTimeEntry {
  approvalStatus: string;
  project: { id: string; name: string; projectNumber: string } | null;
}

export type EntryOptions = TimeEntryOptions;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function TimesheetClient({
  openForm = false,
  weekStart,
  entries,
  options,
}: {
  /** Opened by the Log time shortcut. */
  openForm?: boolean;
  weekStart: string;
  entries: Entry[];
  options: EntryOptions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(openForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const weekEnd = addDays(weekStart, 6);
  const lastDay = weekEnd < today ? weekEnd : today;
  const totalHours = entries.reduce((s, e) => s + Number(e.hours), 0);
  const billableHours = entries.filter((e) => e.billable).reduce((s, e) => s + Number(e.hours), 0);
  const hoursOn = (day: string) =>
    entries.filter((e) => e.workDate.slice(0, 10) === day).reduce((s, e) => s + Number(e.hours), 0);

  /**
   * Days where two entries claim the same clock time. A warning rather than a
   * refusal: two things genuinely do run at once, and a reviewer can query it.
   */
  const overlappingDays = useMemo(() => {
    const byDay = new Map<string, Entry[]>();
    for (const e of entries) {
      const day = e.workDate.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), e]);
    }
    return [...byDay.entries()].filter(([, d]) => findOverlaps(d).length > 0).map(([day]) => day);
  }, [entries]);

  const saved = () => {
    setAdding(false);
    setEditingId(null);
    router.refresh();
  };

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteTimeLog(id);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon">
              <Link href={`/timesheets?week=${addDays(weekStart, -7)}`} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Link>
            </Button>
            <div className="min-w-[13rem] text-center">
              <p className="text-sm font-medium">{formatDate(weekStart)} – {formatDate(weekEnd)}</p>
              <p className="text-xs text-muted-foreground">{formatNumber(totalHours, 2)}h logged · {formatNumber(billableHours, 2)}h billable</p>
            </div>
            <Button asChild variant="outline" size="icon">
              <Link href={`/timesheets?week=${addDays(weekStart, 7)}`} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Link>
            </Button>
          </div>
          {weekStart <= today && (
            <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(!adding); setEditingId(null); }}>
              {adding ? "Cancel" : <><Plus className="h-4 w-4" /> Log time</>}
            </Button>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-7 gap-2">
            {days.map((day, i) => {
              const h = hoursOn(day);
              return (
                <div key={day} className={cn("rounded-md border p-2 text-center", h === 0 && "opacity-60")}>
                  <p className="text-xs font-medium text-muted-foreground">{DAYS[i]}</p>
                  <p className="mt-0.5 text-sm font-semibold tabular">{h > 0 ? formatNumber(h, 2) : "—"}</p>
                </div>
              );
            })}
          </div>

          {overlappingDays.length > 0 && (
            <Alert tone="warning">
              Two entries claim the same clock time on {overlappingDays.map((d) => formatDate(d)).join(", ")}. That may be
              deliberate (a review during a meeting), but if it is not, the same hour is counted twice.
            </Alert>
          )}

          {adding && (
            <div className="rounded-md border bg-muted/30 p-4">
              <TimeEntryForm options={options} defaultDate={lastDay} minDate={weekStart} maxDate={lastDay}
                onSaved={saved} onCancel={() => setAdding(false)} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Entries</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing logged this week. You can book time to any project you are an active member of, or to a support case you own.
            </p>
          ) : (
            entries.map((e) => {
              const locked = e.approvalStatus === "APPROVED" || e.approvalStatus === "SUBMITTED";
              return (
                <div key={e.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {e.project ? (
                          <Link href={`/projects/${e.project.id}`} className="hover:underline">{e.project.name}</Link>
                        ) : e.case ? (
                          <Link href={`/cases/${e.case.id}`} className="hover:underline">{e.case.caseNumber} - {e.case.subject}</Link>
                        ) : "Unlinked"}
                        {e.projectTask && <span className="text-muted-foreground"> · {e.projectTask.name}</span>}
                      </p>
                      <RichText value={e.description} className="mt-1 text-muted-foreground" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold tabular">{formatNumber(e.hours, 2)}h</span>
                      {!e.billable && <Badge tone="neutral">Non-billable</Badge>}
                      <Badge tone={statusTone(e.approvalStatus)}>{humanize(e.approvalStatus)}</Badge>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(e.workDate)}
                      {e.startTime && e.endTime && <> · {clockValue(e.startTime)}–{clockValue(e.endTime)}</>}
                    </span>
                    {!locked && (
                      <>
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setEditingId(editingId === e.id ? null : e.id); setAdding(false); }}>
                          Edit
                        </Button>
                        <Button type="button" variant="ghost" size="icon" disabled={pending} onClick={() => remove(e.id)} aria-label="Delete entry">
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </>
                    )}
                  </div>
                  {editingId === e.id && (
                    <div className="mt-3 border-t pt-3">
                      <TimeEntryForm options={options} entry={e} minDate={weekStart} maxDate={lastDay}
                        onSaved={saved} onCancel={() => setEditingId(null)} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
