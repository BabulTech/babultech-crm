"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { CalendarClock, Check, Mail, MessageSquare, Phone, Users, X } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea,
} from "@/components/ui";
import { formatDateTime, humanize } from "@/lib/utils";
import {
  closePartnerActivity, logPartnerActivity,
  type PartnerActivity, type PartnerActivityEntity,
} from "@/server/partner-leads";

const KINDS = [
  { value: "CALL", label: "Call made" },
  { value: "MEETING", label: "Meeting" },
  { value: "LOG", label: "Note" },
  { value: "TASK", label: "Follow-up to do" },
] as const;

const ICON: Record<string, typeof Phone> = {
  CALL: Phone, MEETING: Users, LOG: MessageSquare, TASK: CalendarClock, EMAIL: Mail,
};

/**
 * What the partner's company has done with one record, and a place to add to
 * it: a call made, a meeting, a note, or a follow-up to do by a date.
 *
 * Only the partner's own entries are here. Our team keeps its own notes on the
 * same record, and those are ours.
 */
export function PartnerActivityPanel({
  entityType,
  entityId,
  activities,
  canLog,
}: {
  entityType: PartnerActivityEntity;
  entityId: string;
  activities: PartnerActivity[];
  canLog: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("CALL");
  const [formKey, setFormKey] = useState(0);

  // A full reload after each change rather than router.refresh(): in the
  // production build a refreshed page can arrive and not be shown (the React
  // 19.2 fault described in components/deal-product-services.tsx).
  const reload = () => softReload();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    start(async () => {
      const result = await logPartnerActivity(entityType, entityId, {
        activityType: kind,
        subject: String(form.get("subject") ?? ""),
        description: String(form.get("description") ?? ""),
        outcome: String(form.get("outcome") ?? ""),
        dueAt: String(form.get("dueAt") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFormKey((k) => k + 1);
      reload();
    });
  }

  function close(id: string, status: "COMPLETED" | "CANCELLED") {
    setError(null);
    start(async () => {
      const result = await closePartnerActivity(id, status);
      if (!result.ok) setError(result.error);
      else reload();
    });
  }

  const openTasks = activities.filter((a) => a.activityType === "TASK" && a.status === "OPEN");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        {openTasks.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            {openTasks.length} follow-up{openTasks.length === 1 ? "" : "s"} to do.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}

        {canLog && (
          <form key={formKey} onSubmit={onSubmit} className="space-y-3 rounded-lg border p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="What">
                <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind of activity">
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="About" required>
                  <Input name="subject" required maxLength={255} placeholder={kind === "TASK" ? "Call back about pricing" : "Discussed the proposal"} />
                </Field>
              </div>
            </div>
            {(kind === "TASK" || kind === "MEETING") && (
              <Field label={kind === "TASK" ? "Do it by" : "When"} required={kind === "TASK"}>
                <Input name="dueAt" type="datetime-local" required={kind === "TASK"} />
              </Field>
            )}
            <Field label="Details">
              <Textarea name="description" rows={2} maxLength={8000} />
            </Field>
            {kind !== "TASK" && (
              <Field label="Outcome" hint="What came of it, and what happens next.">
                <Input name="outcome" maxLength={4000} />
              </Field>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Add"}</Button>
            </div>
          </form>
        )}

        {activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          <ul className="space-y-3">
            {activities.map((a) => {
              const Icon = ICON[a.activityType] ?? MessageSquare;
              const openTask = a.activityType === "TASK" && a.status === "OPEN";
              return (
                <li key={a.id} className="flex gap-3 rounded-md border p-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.subject}</span>
                      {a.activityType === "TASK" && (
                        <Badge tone={a.status === "OPEN" ? "warning" : a.status === "COMPLETED" ? "success" : "neutral"}>
                          {a.status === "OPEN" ? "To do" : humanize(a.status)}
                        </Badge>
                      )}
                      {a.activityType === "EMAIL" && (
                        <Badge tone={a.bouncedAt ? "danger" : a.openedAt ? "success" : "neutral"}>
                          {a.bouncedAt ? "Bounced" : a.clickedAt ? "Clicked" : a.openedAt ? "Opened" : a.sentAt ? "Sent" : "Queued"}
                        </Badge>
                      )}
                    </div>
                    {a.description && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{a.description}</p>}
                    {a.outcome && <p className="mt-1"><span className="text-muted-foreground">Outcome:</span> {a.outcome}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.owner?.fullName ? `${a.owner.fullName} · ` : ""}
                      {a.activityType === "TASK" && a.dueAt ? `Due ${formatDateTime(a.dueAt)}` : formatDateTime(a.createdAt)}
                      {a.toAddress ? ` · to ${a.toAddress}` : ""}
                    </p>
                  </div>
                  {openTask && canLog && (
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button size="sm" variant="outline" onClick={() => close(a.id, "COMPLETED")} disabled={pending}>
                        <Check className="h-3.5 w-3.5" /> Done
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => close(a.id, "CANCELLED")} disabled={pending}>
                        <X className="h-3.5 w-3.5" /> Not needed
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
