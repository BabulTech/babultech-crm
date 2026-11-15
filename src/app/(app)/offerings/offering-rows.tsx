"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Input, Badge } from "@/components/ui";
import { createOffering, updateOffering } from "@/server/offerings";

export function AddOffering() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  return (
    <form key={key} className="space-y-2" action={(fd) => start(async () => {
      setError(null);
      const r = await createOffering({ name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? "") || null });
      if (!r.ok) setError(r.error); else { setKey((k) => k + 1); router.refresh(); }
    })}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Input name="name" placeholder="e.g. ERP implementation" className="min-w-[200px] flex-1" />
        <Input name="description" placeholder="Short description (optional)" className="min-w-[200px] flex-[2]" />
        <Button type="submit" disabled={pending}>Add offering</Button>
      </div>
    </form>
  );
}

export function OfferingRow({ id, name, description, active, playbooks, templates }: { id: string; name: string; description: string | null; active: boolean; playbooks: string[]; templates: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? "That did not work."); else { setEditing(false); router.refresh(); }
  });
  return (
    <div className={`space-y-2 p-4 ${active ? "" : "opacity-60"}`}>
      {error && <Alert tone="danger">{error}</Alert>}
      {editing ? (
        <form className="flex flex-wrap gap-2" action={(fd) => run(() => updateOffering(id, { name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? "") || null }))}>
          <Input name="name" defaultValue={name} className="min-w-[200px] flex-1" />
          <Input name="description" defaultValue={description ?? ""} className="min-w-[200px] flex-[2]" />
          <Button type="submit" size="sm" disabled={pending}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-medium">{name} {!active && <Badge>Hidden</Badge>}</div>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
            <p className="mt-1 text-xs text-muted-foreground">
              Proposal: {templates.length ? templates.join(", ") : "none yet"} · Onboarding: {playbooks.length ? playbooks.join(", ") : "none yet"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Rename</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => updateOffering(id, { active: !active }))}>{active ? "Hide" : "Show again"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
