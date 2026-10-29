"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, CardContent, Textarea } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import { submitTimesheetWeek, type getMyTimesheetWeek } from "@/server/weekly-timesheets";

type Week = NonNullable<Awaited<ReturnType<typeof getMyTimesheetWeek>>>;

const STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  SUBMITTED: { label: "Submitted, waiting for approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  RETURNED: { label: "Returned to you", tone: "danger" },
};

/** Committed against logged hours for the week, and submitting it. */
export function WeekCommitment({ weekStart, week, isFuture }: { weekStart: string; week: Week; isFuture: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const short = week.logged < week.committed;
  const pct = week.committed ? Math.min(100, Math.round((week.logged / week.committed) * 100)) : 0;
  const canSubmit = !isFuture && (week.status === null || week.status === "RETURNED");

  function submit() {
    setError(null);
    if (!window.confirm(`Submit this week with ${week.logged} of ${week.committed} hours?`)) return;
    start(async () => {
      const r = await submitTimesheetWeek(weekStart, reason);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <Card data-testid="week-commitment">
      <CardContent className="space-y-3 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            <span className="text-lg font-semibold">{week.logged} of {week.committed} hours</span>{" "}
            <span className="text-muted-foreground">logged against your weekly commitment</span>
          </p>
          {week.status ? <Badge tone={STATUS[week.status].tone}>{STATUS[week.status].label}</Badge> : <Badge tone="neutral">Not submitted</Badge>}
        </div>
        <div className="h-2 overflow-hidden rounded bg-muted">
          <div className={`h-full ${short ? "bg-amber-500" : "bg-emerald-600"}`} style={{ width: `${pct}%` }} />
        </div>
        {week.status === "RETURNED" && week.remarks && (
          <Alert tone="danger">Returned by {week.decidedBy ?? "an approver"}: {week.remarks}. Fix your entries and submit again.</Alert>
        )}
        {week.status === "APPROVED" && (
          <p className="text-xs text-muted-foreground">Approved by {week.decidedBy}{week.decidedAt ? `, ${formatDateTime(week.decidedAt)}` : ""}{week.remarks ? `: ${week.remarks}` : ""}</p>
        )}
        {week.status === "SUBMITTED" && week.shortfallReason && <p className="text-xs text-muted-foreground">Your reason for the short week: {week.shortfallReason}</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        {canSubmit && (
          <div className="space-y-2">
            {short && (
              <Textarea aria-label="Why the week is short" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={`You are ${Math.round((week.committed - week.logged) * 10) / 10} hours short. Say why, for example: no work assigned on Thursday, or a day of leave.`} />
            )}
            <Button onClick={submit} disabled={pending || (short && reason.trim().length < 3)}>{pending ? "Submitting…" : week.status === "RETURNED" ? "Submit the week again" : "Submit week"}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
