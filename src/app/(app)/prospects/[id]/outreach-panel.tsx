"use client";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/utils";
import { AddToCalendar } from "@/components/add-to-calendar";
import {
  ACTIVITY_LABELS, CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABELS, CHANNELS, CHANNEL_LABELS, QUICK_LOG_ACTIONS, TASK_TYPE_LABELS,
  channelAllows, type CampaignStatus, type Channel, type QuickLogAction,
} from "@/lib/prospect-outreach";
import {
  addProspectNote, addProspectsToCampaign, createProspectTask, quickLogProspect, setCampaignStatus, setProspectTaskDone, type QuickLogResult,
} from "@/server/prospect-campaigns";

interface Entry { campaignId: string; status: string; touchCount: number; lastContactedAt: string | null; campaign: { name: string; defaultChannel: string | null; status: string } | null }
interface Activity { id: string; type: string; channel: string | null; content: string | null; occurredAt: string; actor: string | null; person: { name: string; role: string | null } | null; campaign: string | null }
interface Task { id: string; title: string; type: string; dueDate: string; priority: string; status: string; assignee: string | null; meetingAt?: string | null; durationMinutes?: number | null }

const reload = () => window.location.reload();

/** Working a prospect in a campaign: status, Quick log, and what happens next. */
export function OutreachPanel({ prospectId, entries, campaignId, people, campaigns, nextProspect, canWrite }: {
  prospectId: string;
  entries: Entry[];
  campaignId: string | null;
  people: { id: string; name: string; role: string | null; isPrimary: boolean }[];
  campaigns: { id: string; name: string }[];
  nextProspect: { id: string; name: string } | null;
  canWrite: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const entry = entries.find((e) => e.campaignId === campaignId) ?? entries[0] ?? null;
  const fixed = (entry?.campaign?.defaultChannel ?? null) as Channel | null;
  const [channel, setChannel] = useState<Channel | "">(fixed ?? "");
  const primary = people.filter((p) => p.isPrimary);
  const [personId, setPersonId] = useState(primary.length === 1 ? primary[0].id : people.length === 1 ? people[0].id : "");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<(QuickLogResult & { action: QuickLogAction }) | null>(null);
  const [addTo, setAddTo] = useState("");
  // Booking a meeting asks for its time first.
  const [booking, setBooking] = useState(false);
  const [meetingAt, setMeetingAt] = useState("");
  const [minutes, setMinutes] = useState("30");

  const switchCampaign = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("campaign", id);
    window.location.assign(url.toString());
  };

  function log(action: QuickLogAction) {
    if (!entry) return;
    if (action === "MEETING_BOOKED" && !booking) { setBooking(true); return; }
    if (action === "MEETING_BOOKED" && !meetingAt) { setError("Meeting time: choose a date and time."); return; }
    setError(null);
    start(async () => {
      const r = await quickLogProspect({
        prospectId, campaignId: entry.campaignId, action, channel: (fixed ?? channel) || null, personId: personId || null, note,
        // The browser reads the box in the person's own time zone.
        ...(action === "MEETING_BOOKED" ? { meetingAt: new Date(meetingAt).toISOString(), durationMinutes: Number(minutes) } : {}),
      });
      if (!r.ok) { setError(r.error); return; }
      setNote("");
      setBooking(false);
      setResult({ ...r.data, action });
    });
  }

  if (!entry) {
    return (
      <Card>
        <CardHeader><CardTitle>Outreach</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">This prospect is not in an outreach campaign yet. Calls and emails are logged within a campaign.</p>
          {error && <Alert tone="danger">{error}</Alert>}
          {canWrite && campaigns.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Campaign to add to" value={addTo} onChange={(e) => setAddTo(e.target.value)} className="w-64">
                <option value="">Choose a campaign…</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Button disabled={pending || !addTo} onClick={() => start(async () => {
                const r = await addProspectsToCampaign(addTo, [prospectId]);
                if (r.ok) switchCampaign(addTo); else setError(r.error);
              })}>Add to campaign</Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const actions = QUICK_LOG_ACTIONS.filter((a) => channelAllows(((fixed ?? channel) || null) as Channel | null, a));

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Outreach</CardTitle>
        {entries.length > 1 ? (
          <Select aria-label="Working in campaign" value={entry.campaignId} onChange={(e) => switchCampaign(e.target.value)} className="h-8 w-64">
            {entries.map((e) => <option key={e.campaignId} value={e.campaignId}>{e.campaign?.name}</option>)}
          </Select>
        ) : <span className="text-sm text-muted-foreground">{entry.campaign?.name}</span>}
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Status</span>
          {canWrite ? (
            <Select aria-label="Status in this campaign" value={entry.status} disabled={pending} className="h-8 w-52"
              onChange={(e) => start(async () => { const r = await setCampaignStatus(entry.campaignId, prospectId, e.target.value as CampaignStatus); if (r.ok) reload(); else setError(r.error); })}>
              {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{CAMPAIGN_STATUS_LABELS[s]}</option>)}
            </Select>
          ) : <Badge tone="info">{CAMPAIGN_STATUS_LABELS[entry.status as CampaignStatus]}</Badge>}
          <span className="text-muted-foreground">{entry.touchCount} touch{entry.touchCount === 1 ? "" : "es"} · last {entry.lastContactedAt ? formatDateTime(entry.lastContactedAt) : "never"}</span>
        </div>

        {result ? (
          <Alert tone="success">
            <p className="font-medium">{ACTIVITY_LABELS[result.action]} logged.</p>
            {result.taskCreated && <p>Follow-up task: {result.taskCreated}.</p>}
            {result.warnings.map((w) => <p key={w}>{w}</p>)}
            {result.meeting && (
              <div className="mt-2">
                <p className="mb-1">{result.meeting.title}, {formatDateTime(result.meeting.start)} for {result.meeting.minutes} minutes.</p>
                <AddToCalendar uid={result.meeting.taskId ?? prospectId} event={{ title: result.meeting.title, start: result.meeting.start, minutes: result.meeting.minutes, details: result.meeting.details, location: result.meeting.location }} />
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {result.suggestion && canWrite && (
                <Button size="sm" disabled={pending} onClick={() => start(async () => {
                  const r = await setCampaignStatus(entry.campaignId, prospectId, result.suggestion!);
                  if (r.ok) reload(); else setError(r.error);
                })}>Move to {CAMPAIGN_STATUS_LABELS[result.suggestion]}</Button>
              )}
              {nextProspect && <Button size="sm" variant="outline" asChild><a href={`/prospects/${nextProspect.id}?campaign=${entry.campaignId}`}>Next: {nextProspect.name}</a></Button>}
              <Button size="sm" variant="ghost" onClick={reload}>Done</Button>
            </div>
          </Alert>
        ) : canWrite && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Channel">
                {fixed ? <p className="pt-2 text-sm">{CHANNEL_LABELS[fixed]} <span className="text-muted-foreground">(set by the campaign)</span></p> : (
                  <Select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")}>
                    <option value="">Not stated</option>
                    {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Spoke to">
                <Select aria-label="Person contacted" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                  <option value="">The business</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? `, ${p.role}` : ""}</option>)}
                </Select>
              </Field>
            </div>
            <Textarea aria-label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened, in a line (optional)" />
            {booking && (
              <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed bg-background p-3">
                <Field label="Meeting on" required>
                  <Input type="datetime-local" aria-label="Meeting date and time" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} />
                </Field>
                <Field label="Length">
                  <Select aria-label="Meeting length" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-32">
                    {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
                  </Select>
                </Field>
                <Button size="sm" disabled={pending || !meetingAt} onClick={() => log("MEETING_BOOKED")}>Log the meeting</Button>
                <Button size="sm" variant="ghost" onClick={() => setBooking(false)}>Cancel</Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button key={a} size="sm" variant={a === "CALL_CONNECTED" || a === "MEETING_BOOKED" ? "default" : "outline"} disabled={pending} onClick={() => log(a)}>
                  {ACTIVITY_LABELS[a]}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Everything logged on the prospect, newest first, with a box to add a note. */
export function OutreachHistory({ prospectId, campaignId, activities, canWrite }: { prospectId: string; campaignId: string | null; activities: Activity[]; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader><CardTitle>History</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {canWrite && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await addProspectNote(prospectId, campaignId, note); if (r.ok) reload(); else setError(r.error); }); }}>
            <Input aria-label="New note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
            <Button type="submit" disabled={pending || !note.trim()}>Add</Button>
          </form>
        )}
        {activities.length === 0 ? <p className="text-sm text-muted-foreground">Nothing logged yet.</p> : (
          <ul className="divide-y text-sm">
            {activities.map((a) => (
              <li key={a.id} className="py-2">
                <p>
                  <span className="font-medium">{ACTIVITY_LABELS[a.type] ?? a.type}</span>
                  {a.channel && <span className="text-muted-foreground"> · {CHANNEL_LABELS[a.channel as Channel] ?? a.channel}</span>}
                  {a.person && <span className="text-muted-foreground"> · {a.person.name}{a.person.role ? ` (${a.person.role})` : ""}</span>}
                </p>
                {a.content && <p className="mt-0.5 whitespace-pre-wrap">{a.type === "STATUS_CHANGED" ? a.content.replace(/[a-z_]+/g, (s) => CAMPAIGN_STATUS_LABELS[s as CampaignStatus] ?? s) : a.content}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground">{[a.actor, formatDateTime(a.occurredAt), a.campaign].filter(Boolean).join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The prospect's tasks: tick one off, or add another. */
export function ProspectTasks({ prospectId, campaignId, tasks, canWrite }: { prospectId: string; campaignId: string | null; tasks: Task[]; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Tasks</CardTitle>
        {canWrite && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add task</Button>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {adding && (
          <form className="space-y-2 rounded-md border border-dashed p-3" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start(async () => {
              const r = await createProspectTask({ title: String(f.get("title") ?? ""), type: String(f.get("type")) as never, dueDate: String(f.get("dueDate") ?? ""), priority: String(f.get("priority")) as never, prospectId, campaignId });
              if (r.ok) reload(); else setError(r.error);
            });
          }}>
            <Field label="Task" required><Input name="title" required maxLength={300} placeholder="Call back after 3pm" /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Due" required><Input name="dueDate" type="date" required defaultValue={today} /></Field>
              <Field label="Kind">
                <Select name="type" defaultValue="call_lead">{Object.entries(TASK_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              </Field>
              <Field label="Priority">
                <Select name="priority" defaultValue="medium"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select>
              </Field>
            </div>
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={pending}>Save</Button><Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button></div>
          </form>
        )}
        {tasks.length === 0 ? <p className="text-muted-foreground">No tasks.</p> : tasks.map((t) => (
          <label key={t.id} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={t.status === "done"} disabled={!canWrite || pending}
              onChange={(e) => start(async () => { const r = await setProspectTaskDone(t.id, e.target.checked); if (r.ok) reload(); else setError(r.error); })} />
            <span className={t.status === "done" ? "text-muted-foreground line-through" : ""}>
              {t.title}
              <span className={`block text-xs ${t.status === "open" && t.dueDate < today ? "text-destructive" : "text-muted-foreground"}`}>
                {t.meetingAt ? `Meeting ${formatDateTime(t.meetingAt)}, ${t.durationMinutes ?? 30} min` : `${TASK_TYPE_LABELS[t.type] ?? t.type} · due ${formatDate(t.dueDate)}`}{t.assignee ? ` · ${t.assignee}` : ""}
              </span>
              {t.meetingAt && t.status === "open" && (
                <span className="mt-1 block">
                  <AddToCalendar uid={t.id} event={{ title: t.title, start: t.meetingAt, minutes: t.durationMinutes ?? 30, }} crmPath={`/prospects/${prospectId}`} />
                </span>
              )}
            </span>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
