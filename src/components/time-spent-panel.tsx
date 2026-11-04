"use client";

import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, statusTone } from "@/components/ui";
import { RichText } from "@/components/rich-text";
import { TimeEntryForm, type TimeEntryOptions } from "@/components/time-entry-form";
import { softReload } from "@/components/soft-navigation";
import { formatDate, formatNumber, humanize } from "@/lib/utils";
import { SALES_ACTIVITIES, SALES_TYPE_LABEL, type SalesType } from "@/lib/sales-types";

export interface SalesTimeRow {
  id: string; workDate: string; hours: number; description: string; salesActivity: string | null;
  salesEntityType: string; userName: string | null; approvalStatus: string; costRate: number | null;
}

const activityLabel = Object.fromEntries(SALES_ACTIVITIES);

/** Time spent on a prospect, lead, deal or account, and a way to log more. */
export function TimeSpentPanel({ type, id, label, rows, options }: {
  type: SalesType; id: string; label: string; rows: SalesTimeRow[]; options: TimeEntryOptions;
}) {
  const [adding, setAdding] = useState(false);
  const hours = rows.reduce((s, r) => s + Number(r.hours), 0);
  const cost = rows.reduce((s, r) => s + Number(r.hours) * Number(r.costRate ?? 0), 0);
  const people = new Set(rows.map((r) => r.userName)).size;
  const fromEarlier = rows.some((r) => r.salesEntityType !== type);

  return (
    <Card data-testid="time-spent-panel">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Time spent
          {!adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Log time</Button>}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {formatNumber(hours, 2)} hours by {people} {people === 1 ? "person" : "people"}{cost ? `, costing PKR ${formatNumber(Math.round(cost), 0)}` : ""}.
          {fromEarlier ? " Includes time on the lead and prospect this came from." : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && (
          <TimeEntryForm options={options} lockSales={{ type, id, label }}
            onSaved={() => { setAdding(false); softReload(); }} onCancel={() => setAdding(false)} />
        )}
        {rows.length === 0 && !adding && <p className="text-sm text-muted-foreground">No time logged yet.</p>}
        {rows.slice(0, 20).map((r) => (
          <div key={r.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {r.userName ?? "Someone"} · {formatDate(r.workDate)}
                {r.salesActivity && <span className="text-muted-foreground"> · {activityLabel[r.salesActivity] ?? humanize(r.salesActivity)}</span>}
                {r.salesEntityType !== type && <span className="text-muted-foreground"> · on the {SALES_TYPE_LABEL[r.salesEntityType as SalesType]?.toLowerCase()}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{formatNumber(Number(r.hours), 2)}h</span>
                <Badge tone={statusTone(r.approvalStatus)}>{humanize(r.approvalStatus)}</Badge>
              </span>
            </div>
            <RichText value={r.description} className="mt-1 text-muted-foreground" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
