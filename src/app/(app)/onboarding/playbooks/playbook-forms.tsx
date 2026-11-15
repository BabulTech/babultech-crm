"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Alert, Input, Select, Textarea, Field, Badge } from "@/components/ui";
import { savePlaybook, savePlaybookStep, deletePlaybookStep, movePlaybookStep } from "@/server/onboarding";
import { PHASES, PHASE_LABELS } from "@/lib/onboarding";

type Offering = { id: string; name: string };
type User = { id: string; fullName: string };

function values(fd: FormData) {
  const v: Record<string, unknown> = {};
  for (const [k, x] of fd.entries()) if (typeof x === "string") v[k] = x;
  return v;
}

export function PlaybookForm({ id, offerings, defaults }: { id: string | null; offerings: Offering[]; defaults?: { name: string; offeringId: string | null; description: string | null; targetDays: number | null; active: boolean } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form className="space-y-3" action={(fd) => {
      setError(null); setSaved(false);
      const v = values(fd);
      start(async () => {
        const r = await savePlaybook(id, { ...v, active: fd.get("active") === "on" || !id });
        if (!r.ok) { setError(r.error); return; }
        if (!id) router.push(`/onboarding/playbooks/${r.data.id}`); else { setSaved(true); router.refresh(); }
      });
    }}>
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Saved.</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" required><Input name="name" defaultValue={defaults?.name ?? ""} required placeholder="e.g. BabulPOS onboarding" /></Field>
        <Field label="Offering" help="Winning a deal with this offering starts this playbook.">
          <Select name="offeringId" defaultValue={defaults?.offeringId ?? ""}>
            <option value="">None</option>
            {offerings.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
        </Field>
        <Field label="Days to go live" hint="Sets the target go-live date."><Input name="targetDays" type="number" min={1} max={730} defaultValue={defaults?.targetDays ?? ""} /></Field>
      </div>
      <Field label="Description"><Textarea name="description" rows={2} defaultValue={defaults?.description ?? ""} /></Field>
      {id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={defaults?.active ?? true} /> In use (untick to stop new onboardings using it)</label>}
      <Button type="submit" disabled={pending}>{id ? "Save" : "Create playbook"}</Button>
    </form>
  );
}

type Step = {
  id: string; phase: string; title: string; instructions: string | null; ownerKind: string; ownerUserId: string | null;
  dueDays: number; stepType: string; requiresNote: boolean; waitsForPrevious: boolean; isGoLive: boolean; owner: { fullName: string } | null;
};

function StepForm({ playbookId, step, users, onDone }: { playbookId: string; step: Step | null; users: User[]; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ownerKind, setOwnerKind] = useState(step?.ownerKind ?? "MANAGER");
  return (
    <form className="space-y-3 rounded-md border bg-muted/30 p-4" data-step-form action={(fd) => {
      setError(null);
      const v = values(fd);
      start(async () => {
        const r = await savePlaybookStep(playbookId, step?.id ?? null, { ...v, requiresNote: fd.get("requiresNote") === "on", waitsForPrevious: fd.get("waitsForPrevious") === "on", isGoLive: fd.get("isGoLive") === "on" });
        if (!r.ok) { setError(r.error); return; }
        onDone(); router.refresh();
      });
    }}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><Field label="Step" required><Input name="title" defaultValue={step?.title ?? ""} required placeholder="e.g. Install hardware" /></Field></div>
        <Field label="Phase">
          <Select name="phase" defaultValue={step?.phase ?? "SETUP"}>
            {PHASES.map((p) => <option key={p} value={p}>{PHASE_LABELS[p]}</option>)}
          </Select>
        </Field>
        <Field label="Who does it">
          <Select name="ownerKind" value={ownerKind} onChange={(e) => setOwnerKind(e.target.value)}>
            <option value="MANAGER">Onboarding manager (the deal owner at first)</option>
            <option value="DEAL_OWNER">Deal owner</option>
            <option value="USER">A named person</option>
          </Select>
        </Field>
        {ownerKind === "USER" && (
          <Field label="Person" required>
            <Select name="ownerUserId" defaultValue={step?.ownerUserId ?? ""}>
              <option value="">Choose…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Due (days after the win)"><Input name="dueDays" type="number" min={0} max={730} defaultValue={step?.dueDays ?? 1} /></Field>
        <Field label="Type">
          <Select name="stepType" defaultValue={step?.stepType ?? "INTERNAL"}>
            <option value="INTERNAL">Our team does it</option>
            <option value="CUSTOMER">We need it from the customer</option>
          </Select>
        </Field>
      </div>
      <Field label="Instructions"><Textarea name="instructions" rows={2} defaultValue={step?.instructions ?? ""} /></Field>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="requiresNote" defaultChecked={step?.requiresNote ?? false} /> Needs a note when done</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="waitsForPrevious" defaultChecked={step?.waitsForPrevious ?? false} /> Waits for the step before it</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="isGoLive" defaultChecked={step?.isGoLive ?? false} /> This is the go-live step</label>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{step ? "Save step" : "Add step"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function StepList({ playbookId, steps, users }: { playbookId: string; steps: Step[]; users: User[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });
  return (
    <div className="space-y-2">
      {steps.map((s, i) => editing === s.id ? (
        <StepForm key={s.id} playbookId={playbookId} step={s} users={users} onDone={() => setEditing(null)} />
      ) : (
        <div key={s.id} className="flex items-start gap-3 rounded-md border p-3">
          <span className="mt-0.5 w-6 text-right text-xs text-muted-foreground">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.title}</span>
              <Badge>{PHASE_LABELS[s.phase as keyof typeof PHASE_LABELS]}</Badge>
              {s.stepType === "CUSTOMER" && <Badge tone="warning">From customer</Badge>}
              {s.isGoLive && <Badge tone="info">Go live</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.ownerKind === "USER" ? s.owner?.fullName ?? "A named person" : s.ownerKind === "DEAL_OWNER" ? "Deal owner" : "Onboarding manager"} · day {s.dueDays}
              {s.waitsForPrevious ? " · waits for previous" : ""}{s.requiresNote ? " · needs a note" : ""}
            </p>
          </div>
          <Button size="icon" variant="ghost" disabled={pending || i === 0} onClick={() => act(() => movePlaybookStep(playbookId, s.id, -1))} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" disabled={pending || i === steps.length - 1} onClick={() => act(() => movePlaybookStep(playbookId, s.id, 1))} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" onClick={() => setEditing(s.id)} aria-label="Edit step"><Pencil className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" disabled={pending} onClick={() => { if (confirm(`Remove "${s.title}"? Onboardings already running keep it.`)) act(() => deletePlaybookStep(playbookId, s.id)); }} aria-label="Remove step"><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      {editing === "new" ? (
        <StepForm playbookId={playbookId} step={null} users={users} onDone={() => setEditing(null)} />
      ) : (
        <Button variant="outline" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add step</Button>
      )}
    </div>
  );
}
