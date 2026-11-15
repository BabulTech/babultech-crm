"use client";

import { useState, useTransition } from "react";

import { Check, RotateCcw, SkipForward } from "lucide-react";
import { Button, Alert, Input, Select, Textarea, Field } from "@/components/ui";
import { completeStep, reopenStep, skipStep, updateStep, updateOnboarding, emailCustomerChecklist } from "@/server/onboarding";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Runs an action. No router.refresh(): every onboarding action revalidates
 * this page, which already sends the updated page back with the result. A
 * second refresh rendered it twice and made each tick slow.
 */
function useRun() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result | { ok: boolean; error?: string }>, done?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) done?.(); else setError(("error" in r && r.error) || "That did not work.");
    });
  };
  return { pending, error, run };
}

export function StepControls({
  stepId, status, requiresNote, blocked, canTick, canRun, isGoLive, users, ownerUserId, dueDate, onChanged,
}: {
  onChanged?: () => void;
  stepId: string; status: string; requiresNote: boolean; blocked: boolean; canTick: boolean; canRun: boolean; isGoLive: boolean;
  users: { id: string; fullName: string }[]; ownerUserId: string | null; dueDate: string | null;
}) {
  const { pending, error, run: runBase } = useRun();
  const run: typeof runBase = (fn, done) => runBase(fn, () => { done?.(); onChanged?.(); });
  const [mode, setMode] = useState<null | "done" | "skip" | "edit">(null);
  const [note, setNote] = useState("");

  if (status !== "TODO") {
    return canRun || canTick ? (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => reopenStep(stepId))}><RotateCcw className="h-3.5 w-3.5" /> Reopen</Button>
    ) : null;
  }
  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      {mode === null && (
        <div className="flex flex-wrap gap-2">
          {canTick && (
            <Button size="sm" disabled={pending || blocked} title={blocked ? "Waits for the step before it" : undefined}
              onClick={() => (requiresNote ? setMode("done") : run(() => completeStep(stepId, null)))}>
              <Check className="h-3.5 w-3.5" /> {isGoLive ? "Mark live" : "Done"}
            </Button>
          )}
          {canRun && <Button size="sm" variant="outline" onClick={() => setMode("edit")}>Reassign / date</Button>}
          {canRun && !isGoLive && <Button size="sm" variant="ghost" onClick={() => setMode("skip")}><SkipForward className="h-3.5 w-3.5" /> Skip</Button>}
        </div>
      )}
      {(mode === "done" || mode === "skip") && (
        <div className="space-y-2">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "done" ? "What was done (required for this step)" : "Why is it being skipped?"} />
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => (mode === "done" ? completeStep(stepId, note) : skipStep(stepId, note)), () => { setMode(null); setNote(""); })}>
              {mode === "done" ? "Save as done" : "Skip step"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === "edit" && (
        <form className="flex flex-wrap items-end gap-2" action={(fd) => run(() => updateStep(stepId, { ownerUserId: String(fd.get("ownerUserId") ?? "") || null, dueDate: String(fd.get("dueDate") ?? "") || null }), () => setMode(null))}>
          <Select name="ownerUserId" defaultValue={ownerUserId ?? ""} className="w-48">
            <option value="">Nobody</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
          <Input name="dueDate" type="date" defaultValue={dueDate ?? ""} className="w-40" />
          <Button size="sm" type="submit" disabled={pending}>Save</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

export function OnboardingSettings({ id, managerUserId, targetGoLive, status, users }: { id: string; managerUserId: string | null; targetGoLive: string | null; status: string; users: { id: string; fullName: string }[] }) {
  const { pending, error, run } = useRun();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <form className="space-y-3" action={(fd) => run(() => updateOnboarding(id, { managerUserId: String(fd.get("managerUserId") ?? "") || null, targetGoLive: String(fd.get("targetGoLive") ?? "") || null }))}>
        <Field label="Onboarding manager">
          <Select name="managerUserId" defaultValue={managerUserId ?? ""}>
            <option value="">Nobody</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        </Field>
        <Field label="Target go-live"><Input name="targetGoLive" type="date" defaultValue={targetGoLive ?? ""} /></Field>
        <Button size="sm" type="submit" variant="outline" disabled={pending}>Save</Button>
      </form>
      {status === "CANCELLED" ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateOnboarding(id, { reactivate: true }))}>Restart onboarding</Button>
      ) : cancelling ? (
        <div className="space-y-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is onboarding being cancelled?" />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => updateOnboarding(id, { cancel: true, cancelReason: reason }), () => setCancelling(false))}>Cancel onboarding</Button>
            <Button size="sm" variant="ghost" onClick={() => setCancelling(false)}>Keep it</Button>
          </div>
        </div>
      ) : status === "ACTIVE" ? (
        <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>Cancel onboarding…</Button>
      ) : null}
    </div>
  );
}

export function CustomerChecklistEmail({ id, contacts, count }: { id: string; contacts: { id: string; name: string; email: string }[]; count: number }) {
  const { pending, error, run } = useRun();
  const [chosen, setChosen] = useState<string[]>(contacts.slice(0, 1).map((c) => c.id));
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  if (count === 0) return <p className="text-sm text-muted-foreground">Nothing is waiting on the customer.</p>;
  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {sent && <Alert tone="success">Sent to {sent}.</Alert>}
      <p className="text-sm text-muted-foreground">Emails the {count} open step{count === 1 ? "" : "s"} we need from the customer as one list.</p>
      {contacts.length === 0 ? <p className="text-sm text-muted-foreground">No contacts with an email on this account.</p> : contacts.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen((l) => e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id))} />
          {c.name} <span className="text-muted-foreground">{c.email}</span>
        </label>
      ))}
      <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional message" />
      <Button size="sm" disabled={pending || chosen.length === 0} onClick={() => {
        let to = "";
        run(async () => { const r = await emailCustomerChecklist(id, chosen, message.trim() || null); if (r.ok) to = r.data.sentTo.join(", "); return r; }, () => setSent(to));
      }}>Email "what we need from you"</Button>
    </div>
  );
}
