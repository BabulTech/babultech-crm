"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Input, Select, Field } from "@/components/ui";
import { createAssetType, createAssetLocation, createAssetCategory, setAssetTypeActive, setAssetLocationActive } from "@/server/inventory";

type Result = { ok: boolean; error?: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, done?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) { done?.(); router.refresh(); } else setError(r.error ?? "That did not work.");
    });
  };
  return { pending, error, run };
}

function values(fd: FormData) {
  const v: Record<string, unknown> = {};
  for (const [k, x] of fd.entries()) if (typeof x === "string") v[k] = x === "" ? null : x;
  return v;
}

export function AddTypeForm({ categories }: { categories: { id: string; name: string }[] }) {
  const { pending, error, run } = useRun();
  const [key, setKey] = useState(0);
  return (
    <form key={key} className="space-y-3" action={(fd) => run(() => createAssetType(values(fd)), () => setKey((k) => k + 1))}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" required><Input name="name" placeholder="e.g. Projector" /></Field>
        <Field label="Category" required>
          <Select name="categoryId" defaultValue="">
            <option value="">Choose…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Tracked" help="One by one: each item gets its own tag and serial number (laptops, screens). Counted: a number per place (bulbs, chairs, licences with seats).">
          <Select name="tracking" defaultValue="INDIVIDUAL">
            <option value="INDIVIDUAL">One by one</option>
            <option value="QUANTITY">Counted</option>
          </Select>
        </Field>
        <Field label="Useful life (months)" hint="Optional"><Input name="usefulLifeMonths" type="number" min={1} max={600} /></Field>
      </div>
      <Button type="submit" disabled={pending}>Add type</Button>
    </form>
  );
}

export function AddNamedForm({ kind }: { kind: "location" | "category" }) {
  const { pending, error, run } = useRun();
  const [key, setKey] = useState(0);
  const action = kind === "location" ? createAssetLocation : createAssetCategory;
  return (
    <form key={key} className="flex flex-wrap items-end gap-3" action={(fd) => run(() => action(values(fd)), () => setKey((k) => k + 1))}>
      {error && <div className="w-full"><Alert tone="danger">{error}</Alert></div>}
      <div className="min-w-[220px] flex-1">
        <Field label={kind === "location" ? "New place" : "New category"}><Input name="name" placeholder={kind === "location" ? "e.g. Conference room" : "e.g. Vehicles"} /></Field>
      </div>
      <Button type="submit" disabled={pending}>Add</Button>
    </form>
  );
}

export function ToggleActive({ kind, id, active }: { kind: "type" | "location"; id: string; active: boolean }) {
  const { pending, error, run } = useRun();
  return (
    <span>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => (kind === "type" ? setAssetTypeActive : setAssetLocationActive)(id, !active))}>
        {active ? "Hide" : "Show again"}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
