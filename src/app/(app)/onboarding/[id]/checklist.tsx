"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import { getOnboardingChecklist } from "@/server/onboarding";
import { PHASES, PHASE_LABELS } from "@/lib/onboarding";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { StepControls } from "./step-actions";

type Step = {
  id: string; phase: string; title: string; instructions: string | null; status: string; dueDate: string | null; stepType: string;
  ownerUserId: string | null; requiresNote: boolean; isGoLive: boolean; blocked: boolean; note: string | null; doneAt: string | null;
  owner: { id: string; fullName: string } | null; doneBy: { fullName: string } | null;
};

/**
 * The steps, redrawn from the server straight after each action. Waiting for
 * the whole page to refresh could take many seconds while the menu was still
 * loading, so a ticked step looked as if nothing had happened.
 */
export function Checklist({ id, initial, status: initialStatus, me, canRun, users }: {
  id: string; initial: Step[]; status: string; me: string; canRun: boolean; users: { id: string; fullName: string }[];
}) {
  const router = useRouter();
  const [steps, setSteps] = useState(initial);
  const [status, setStatus] = useState(initialStatus);
  const [, start] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  const reload = async () => {
    const fresh = await getOnboardingChecklist(id);
    if (fresh) { setSteps(fresh.steps as Step[]); setStatus(fresh.status); }
    // The figures and history at the top follow when the page refreshes.
    start(() => router.refresh());
  };

  return (
    <div className="space-y-6">
      {PHASES.filter((ph) => steps.some((s) => s.phase === ph)).map((ph) => (
        <Card key={ph}>
          <CardHeader><CardTitle>{PHASE_LABELS[ph]}</CardTitle></CardHeader>
          <CardContent className="divide-y p-0">
            {steps.filter((s) => s.phase === ph).map((s) => {
              const overdue = s.status === "TODO" && s.dueDate && s.dueDate < today;
              const canTick = status === "ACTIVE" && (s.ownerUserId === me || canRun);
              return (
                <div key={s.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start" data-step={s.title}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-medium ${s.status !== "TODO" ? "text-muted-foreground line-through" : ""}`}>{s.title}</span>
                      {s.stepType === "CUSTOMER" && <Badge tone="warning">From customer</Badge>}
                      {s.isGoLive && <Badge tone="info">Go live</Badge>}
                      {s.status === "DONE" && <Badge tone="success">Done</Badge>}
                      {s.status === "SKIPPED" && <Badge>Skipped</Badge>}
                      {s.blocked && s.status === "TODO" && <Badge>Waits for previous step</Badge>}
                    </div>
                    {s.instructions && <p className="mt-1 text-sm text-muted-foreground">{s.instructions}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.owner?.fullName ?? "No owner"} · <span className={overdue ? "font-medium text-red-600" : ""}>due {formatDate(s.dueDate)}{overdue ? " (overdue)" : ""}</span>
                      {s.doneAt && ` · ${humanize(s.status)} ${formatDateTime(s.doneAt)} by ${s.doneBy?.fullName ?? "—"}`}
                    </p>
                    {s.note && <p className="mt-1 rounded bg-muted/50 p-2 text-sm">{s.note}</p>}
                  </div>
                  <div className="shrink-0">
                    <StepControls key={`${s.id}-${s.status}-${s.blocked}`} stepId={s.id} status={s.status} requiresNote={s.requiresNote} blocked={s.blocked} canTick={canTick}
                      canRun={canRun && status === "ACTIVE"} isGoLive={s.isGoLive} users={users} ownerUserId={s.ownerUserId} dueDate={s.dueDate} onChanged={reload} />
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
