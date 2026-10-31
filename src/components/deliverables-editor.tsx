"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { FormDialog } from "@/components/form-dialog";
import { formatDate } from "@/lib/utils";
import { saveDeliverable, submitDeliverable, deleteDeliverable, type Deliverable } from "@/server/deliverables";

const STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "warning" }> = {
  PLANNED: { label: "Planned", tone: "neutral" },
  SUBMITTED: { label: "With the customer", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  CHANGES_REQUESTED: { label: "Changes asked for", tone: "warning" },
};

type Draft = { id: string | null; name: string; milestoneId: string; dueDate: string; link: string; description: string };
const BLANK: Draft = { id: null, name: "", milestoneId: "", dueDate: "", link: "", description: "" };

export function DeliverablesEditor({
  projectId,
  deliverables,
  milestones,
  canManage,
}: {
  projectId: string;
  deliverables: Deliverable[];
  milestones: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A full reload after each change: see components/log-touch-button.tsx.
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const result = await fn();
      if (!result.ok && "error" in result) return window.alert(result.error);
      softReload();
    });

  const save = () =>
    start(async () => {
      if (!draft) return;
      setError(null);
      const result = await saveDeliverable({
        id: draft.id,
        projectId,
        milestoneId: draft.milestoneId || null,
        name: draft.name,
        description: draft.description,
        link: draft.link,
        dueDate: draft.dueDate || null,
      });
      if (!result.ok) return setError(result.error);
      softReload();
    });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Deliverables</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            What the customer receives and signs off. Handing one over shows it in their support portal, where their Admin approves it or asks for changes.
          </p>
        </div>
        {canManage && <Button size="sm" onClick={() => { setError(null); setDraft({ ...BLANK }); }}>Add a deliverable</Button>}
      </CardHeader>
      <CardContent>
        {deliverables.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-3">
            {deliverables.map((d) => (
              <li key={d.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[d.milestoneName && `Milestone: ${d.milestoneName}`, d.dueDate && `Due ${formatDate(d.dueDate)}`].filter(Boolean).join(" · ") || "No milestone or date"}
                    </p>
                  </div>
                  <Badge tone={STATUS[d.status]?.tone ?? "neutral"}>{STATUS[d.status]?.label ?? d.status}</Badge>
                </div>
                {d.description && <p className="mt-2 whitespace-pre-line text-muted-foreground">{d.description}</p>}
                {d.link && (
                  <a href={d.link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-primary hover:underline">Open it</a>
                )}
                {d.customerComment && (
                  <div className="mt-2">
                    <Alert tone={d.status === "APPROVED" ? "success" : "warning"}>
                      {d.decidedByName ?? "The customer"}{d.decidedAt ? ` on ${formatDate(d.decidedAt)}` : ""}: {d.customerComment}
                    </Alert>
                  </div>
                )}
                {canManage && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(d.status === "PLANNED" || d.status === "CHANGES_REQUESTED") && (
                      <Button size="sm" disabled={pending} onClick={() => act(() => submitDeliverable(d.id))}>
                        {d.status === "PLANNED" ? "Hand to the customer" : "Hand back to the customer"}
                      </Button>
                    )}
                    {d.status !== "APPROVED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setDraft({ id: d.id, name: d.name, milestoneId: d.milestoneId ?? "", dueDate: d.dueDate ?? "", link: d.link ?? "", description: d.description ?? "" })}
                      >
                        Edit
                      </Button>
                    )}
                    {d.status === "PLANNED" && (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => window.confirm(`Remove "${d.name}"?`) && act(() => deleteDeliverable(d.id))}>
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <FormDialog open={Boolean(draft)} onOpenChange={(v) => !v && setDraft(null)} title={draft?.id ? "Edit deliverable" : "Add a deliverable"}>
        {draft && (
          <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Name" required>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={200} placeholder="Design mock-ups" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Milestone">
                <Select value={draft.milestoneId} onChange={(e) => setDraft({ ...draft, milestoneId: e.target.value })}>
                  <option value="">None</option>
                  {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              <Field label="Due">
                <Input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
              </Field>
            </div>
            <Field label="Link" help="Where the customer finds it: a document, a staging site, a build.">
              <Input value={draft.link} onChange={(e) => setDraft({ ...draft, link: e.target.value })} placeholder="https://" />
            </Field>
            <Field label="Description">
              <Textarea rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
              <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save deliverable"}</Button>
            </div>
          </div>
        )}
      </FormDialog>
    </Card>
  );
}
