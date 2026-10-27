"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Field, Input, Textarea } from "@/components/ui";
import { deleteDataset, saveDataset } from "@/server/prospects";

function DatasetForm({ id, name = "", description = "", onCancel }: { id: string | null; name?: string; description?: string | null; onCancel: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="mt-2 space-y-2 rounded-md border border-dashed p-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      start(async () => {
        const result = await saveDataset(id, { name: String(f.get("name") ?? ""), description: String(f.get("description") ?? "") });
        if (result.ok) window.location.reload(); else setError(result.error);
      });
    }}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" required><Input name="name" defaultValue={name} required maxLength={200} /></Field>
      <Field label="Description"><Textarea name="description" rows={2} defaultValue={description ?? ""} /></Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function NewDataset() {
  const [open, setOpen] = useState(false);
  return open ? <DatasetForm id={null} onCancel={() => setOpen(false)} /> : <Button variant="outline" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New dataset</Button>;
}

export function DatasetActions({ dataset }: { dataset: { id: string; name: string; description: string | null; total: number } }) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (editing) return <DatasetForm id={dataset.id} name={dataset.name} description={dataset.description} onCancel={() => setEditing(false)} />;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Rename</Button>
      {dataset.total === 0 && (
        <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => {
          if (!window.confirm(`Delete the empty dataset "${dataset.name}"?`)) return;
          start(async () => { const r = await deleteDataset(dataset.id); if (r.ok) window.location.reload(); else setError(r.error); });
        }}>Delete</Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
