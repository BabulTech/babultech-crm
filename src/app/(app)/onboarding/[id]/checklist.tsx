"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import { getOnboardingChecklist } from "@/server/onboarding";
import { PHASES, PHASE_LABELS, STEP_STATUS_LABELS, STEP_STATUS_TONES, isStepFinished, type StepStatus } from "@/lib/onboarding";
import { formatDate, formatDateTime } from "@/lib/utils";
import { StepControls } from "./step-actions";

type Step = {
  id: string; phase: string; title: string; instructions: string | null; status: string; dueDate: string | null; stepType: string;
  ownerUserId: string | null; requiresNote: boolean; isGoLive: boolean; blocked: boolean; note: string | null; doneAt: string | null;
  startedAt: string | null; statusChangedAt: string | null;
  owner: { id: string; fullName: string } | null; doneBy: { fullName: string } | null; changedBy: { fullName: string } | null;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "done", label: "Completed" },
] as const;

/**
 * The steps, redrawn from the server straight after each change. Waiting for
 * the whole page to refresh could take many seconds while the menu was still
 * loading, so a changed step looked as if nothing had happened.
 */
export function Checklist({ id, initial, status: initialStatus, me, canRun, users }: {
  id: string; initial: Step[]; status: string; me: string; canRun: boolean; users: { id: string; fullName: string }[];
}) {
  const router = useRouter();
  const [steps, setSteps] = useState(initial);
  const [status, setStatus] = useState(initialStatus);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [, start] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  const reload = async () => {
    const fresh = await getOnboardingChecklist(id);
    if (fresh) { setSteps(fresh.steps as Step[]); setStatus(fresh.status); }
    // The figures and history at the top follow when the page refreshes.
    start(() => router.refresh());
  };

  const shown = steps.filter((s) =>
    filter === "open" ? !isStepFinished(s.status)
      : filter === "mine" ? s.ownerUserId === me
      : filter === "done" ? isStepFinished(s.status)
      : true);
  const count = (k: (typeof FILTERS)[number]["key"]) => steps.filter((s) =>
    k === "open" ? !isStepFinished(s.status) : k === "mine" ? s.ownerUserId === me : k === "done" ? isStepFinished(s.status) : true).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" data-step-filter>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium ${filter === f.key ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>
            {f.label} ({count(f.key)})
          </button>
        ))}
      </div>

      {shown.length === 0 && <p className="text-sm text-muted-foreground">No steps here.</p>}

      {PHASES.filter((ph) => shown.some((s) => s.phase === ph)).map((ph) => (
        <Card key={ph}>
          <CardHeader><CardTitle>{PHASE_LABELS[ph]}</CardTitle></CardHeader>
          <CardContent className="divide-y p-0">
            {shown.filter((s) => s.phase === ph).map((s) => {
              const finished = isStepFinished(s.status);
              const overdue = !finished && s.dueDate && s.dueDate < today;
              const canChange = status !== "CANCELLED" && (s.ownerUserId === me || canRun);
              return (
                <div key={s.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start" data-step={s.title} data-status={s.status}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-medium ${finished ? "text-muted-foreground" : ""} ${s.status === "NOT_REQUIRED" ? "line-through" : ""}`}>{s.title}</span>
                      <Badge tone={STEP_STATUS_TONES[s.status as StepStatus]}>{STEP_STATUS_LABELS[s.status as StepStatus] ?? s.status}</Badge>
                      {s.stepType === "CUSTOMER" && <Badge tone="warning">From customer</Badge>}
                      {s.isGoLive && <Badge tone="info">Go live</Badge>}
                      {s.blocked && !finished && <Badge>Waits for previous step</Badge>}
                    </div>
                    {s.instructions && <p className="mt-1 text-sm text-muted-foreground">{s.instructions}</p>}
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2" data-step-details>
                      <div><dt className="inline text-muted-foreground">Assigned to: </dt><dd className="inline font-medium">{s.owner?.fullName ?? "Nobody"}</dd></div>
                      <div><dt className="inline text-muted-foreground">Due: </dt><dd className={`inline ${overdue ? "font-medium text-red-600" : ""}`}>{formatDate(s.dueDate)}{overdue ? " (overdue)" : ""}</dd></div>
                      {s.startedAt && <div><dt className="inline text-muted-foreground">Started: </dt><dd className="inline">{formatDateTime(s.startedAt)}</dd></div>}
                      {finished && s.doneAt && (
                        <div><dt className="inline text-muted-foreground">{s.status === "COMPLETED" ? "Completed" : "Marked not required"}: </dt><dd className="inline">{formatDateTime(s.doneAt)} by {s.doneBy?.fullName ?? "—"}</dd></div>
                      )}
                      {s.statusChangedAt && (
                        <div><dt className="inline text-muted-foreground">Last updated: </dt><dd className="inline">{formatDateTime(s.statusChangedAt)} by {s.changedBy?.fullName ?? "—"}</dd></div>
                      )}
                    </dl>
                    {s.note && <p className="mt-2 rounded bg-muted/50 p-2 text-sm">{s.note}</p>}
                  </div>
                  <div className="shrink-0">
                    <StepControls key={`${s.id}-${s.status}-${s.blocked}`} stepId={s.id} status={s.status} requiresNote={s.requiresNote} hasNote={Boolean(s.note)}
                      blocked={s.blocked} canChange={canChange} canRun={canRun && status !== "CANCELLED"} isGoLive={s.isGoLive}
                      users={users} ownerUserId={s.ownerUserId} dueDate={s.dueDate} onChanged={reload} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
