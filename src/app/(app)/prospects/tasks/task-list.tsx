"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/utils";
import { TASK_TYPE_LABELS } from "@/lib/prospect-outreach";
import { setProspectTaskDone } from "@/server/prospect-campaigns";
import { AddToCalendar } from "@/components/add-to-calendar";

interface Row {
  id: string; title: string; type: string; dueDate: string; priority: string; status: string;
  prospectId: string | null; campaignId: string | null; prospect: string | null; campaign: string | null; assignee: string | null;
  meetingAt?: string | null; durationMinutes?: number | null;
}

export function TaskList({ rows, canWrite, showAssignee }: { rows: Row[]; canWrite: boolean; showAssignee: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  if (!rows.length) return <p className="p-6 text-sm text-muted-foreground">Nothing here.</p>;
  return (
    <>
      {error && <div className="p-4"><Alert tone="danger">{error}</Alert></div>}
      <Table>
        <THead>
          <TR>
            <TH className="w-8" />
            <TH>Task</TH>
            <TH>Prospect</TH>
            <TH>Due</TH>
            {showAssignee && <TH priority="secondary">Assigned to</TH>}
          </TR>
        </THead>
        <TBody>
          {rows.map((t) => (
            <TR key={t.id}>
              <TD>
                <input type="checkbox" aria-label={`Done: ${t.title}`} checked={t.status === "done"} disabled={!canWrite || pending}
                  onChange={(e) => start(async () => {
                    const r = await setProspectTaskDone(t.id, e.target.checked);
                    if (r.ok) window.location.reload(); else setError(r.error);
                  })} />
              </TD>
              <TD>
                <span className={t.status === "done" ? "text-muted-foreground line-through" : "font-medium"}>{t.title}</span>
                <p className="text-xs text-muted-foreground">
                  {t.meetingAt ? `Meeting ${formatDateTime(t.meetingAt)}, ${t.durationMinutes ?? 30} min` : TASK_TYPE_LABELS[t.type] ?? t.type}
                  {t.priority === "high" && <Badge tone="danger" className="ml-2">High</Badge>}
                </p>
                {t.meetingAt && t.status === "open" && (
                  <span className="mt-1 block">
                    <AddToCalendar uid={t.id} event={{ title: t.title, start: t.meetingAt, minutes: t.durationMinutes ?? 30, }} crmPath={t.prospectId ? `/prospects/${t.prospectId}` : undefined} />
                  </span>
                )}
              </TD>
              <TD className="text-sm">
                {t.prospectId ? (
                  <Link href={`/prospects/${t.prospectId}${t.campaignId ? `?campaign=${t.campaignId}` : ""}`} className="hover:underline">{t.prospect}</Link>
                ) : "—"}
                {t.campaign && <p className="text-xs text-muted-foreground">{t.campaign}</p>}
              </TD>
              <TD className={`whitespace-nowrap text-sm ${t.status === "open" && t.dueDate < today ? "text-destructive" : ""}`}>{formatDate(t.dueDate)}</TD>
              {showAssignee && <TD priority="secondary" className="text-sm">{t.assignee ?? "—"}</TD>}
            </TR>
          ))}
        </TBody>
      </Table>
    </>
  );
}
