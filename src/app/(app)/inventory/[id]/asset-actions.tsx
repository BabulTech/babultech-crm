"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert, Input, Select, Textarea, Field } from "@/components/ui";
import { assignAsset, returnAssignment, setAssetStatus, adjustStock, addAssetNote } from "@/server/inventory";
import { CONDITION_OPTIONS, PurchaseFields, type InventoryFormOptions } from "../asset-form";

type Result = { ok: boolean; error?: string };

/** A small form that runs one action and refreshes the page. */
function MiniForm({
  action,
  submitLabel,
  children,
  onDone,
  variant = "default",
}: {
  action: (values: Record<string, unknown>) => Promise<Result>;
  submitLabel: string;
  children: ReactNode;
  onDone?: () => void;
  variant?: "default" | "outline";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      action={(fd) => {
        const values: Record<string, unknown> = {};
        for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v === "" ? null : v;
        setError(null);
        start(async () => {
          const r = await action(values);
          if (r.ok) {
            onDone?.();
            router.refresh();
          } else setError(r.error ?? "That did not work.");
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {children}
      <Button type="submit" variant={variant} disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
    </form>
  );
}

function ConditionSelect({ name = "condition", defaultValue }: { name?: string; defaultValue?: string }) {
  return (
    <Select name={name} defaultValue={defaultValue ?? "GOOD"}>
      {CONDITION_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </Select>
  );
}

export function AssignPanel({
  assetId,
  tracking,
  available,
  condition,
  locations,
  users,
}: {
  assetId: string;
  tracking: string;
  available: number;
  condition: string;
  locations: { id: string; name: string }[];
  /** Active staff only. */
  users: { id: string; fullName: string }[];
}) {
  const [to, setTo] = useState<"USER" | "LOCATION">("USER");
  const [userId, setUserId] = useState("");
  if (available <= 0) {
    return <p className="text-sm text-muted-foreground">{tracking === "QUANTITY" ? "None left in stock to give out." : "Someone has it. Take it back below before giving it to someone else."}</p>;
  }
  return (
    <MiniForm action={(v) => assignAsset(assetId, v)} submitLabel="Give it out" onDone={() => setUserId("")}>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="to" value="USER" checked={to === "USER"} onChange={() => setTo("USER")} /> A person</label>
        <label className="flex items-center gap-2"><input type="radio" name="to" value="LOCATION" checked={to === "LOCATION"} onChange={() => setTo("LOCATION")} /> A place (room, office)</label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {to === "USER" ? (
          <Field label="Person" required>
            <Select name="assigneeUserId" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Place" required>
            <Select name="locationId" defaultValue="">
              <option value="">Choose…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        )}
        {tracking === "QUANTITY" && (
          <Field label={`How many (${available} free)`}>
            <Input name="quantity" type="number" min={1} max={available} defaultValue={1} />
          </Field>
        )}
        <Field label="Condition when handed over"><ConditionSelect defaultValue={condition} /></Field>
      </div>
      <Field label="Note"><Input name="note" placeholder="e.g. with charger and bag" /></Field>
      {to === "USER" && <p className="text-xs text-muted-foreground">They are notified and asked to confirm they received it.</p>}
    </MiniForm>
  );
}

export function ReturnButton({ assignmentId, label }: { assignmentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Take back</Button>;
  return (
    <div className="mt-2 rounded-md border p-3">
      <MiniForm action={(v) => returnAssignment(assignmentId, v)} submitLabel={`Take back from ${label}`} onDone={() => setOpen(false)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Condition it came back in"><ConditionSelect /></Field>
          <Field label="Note"><Input name="note" /></Field>
        </div>
      </MiniForm>
    </div>
  );
}

const STATUS_CHOICES = [
  { value: "IN_REPAIR", label: "Sent for repair" },
  { value: "IN_STOCK", label: "Back in stock / repaired" },
  { value: "RETIRED", label: "Retired (no longer used)" },
  { value: "LOST", label: "Lost or stolen" },
  { value: "DISPOSED", label: "Disposed of or sold" },
];

export function StatusPanel({ assetId, status, condition }: { assetId: string; status: string; condition: string }) {
  return (
    <MiniForm action={(v) => setAssetStatus(assetId, v)} submitLabel="Update" variant="outline">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What happened">
          <Select name="status" defaultValue={status === "IN_REPAIR" ? "IN_STOCK" : "IN_REPAIR"}>
            {STATUS_CHOICES.filter((s) => s.value !== status).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Condition now"><ConditionSelect defaultValue={condition} /></Field>
      </div>
      <Field label="Note" hint="Required except when it goes back into stock.">
        <Textarea name="note" rows={2} placeholder="e.g. screen cracked, sent to Ali Computers" />
      </Field>
      <p className="text-xs text-muted-foreground">Anything other than back in stock takes it back from whoever has it.</p>
    </MiniForm>
  );
}

export function StockPanel({ assetId, options, available }: { assetId: string; options: InventoryFormOptions; available: number }) {
  const [direction, setDirection] = useState<"IN" | "OUT">("IN");
  const [count, setCount] = useState(1);
  return (
    <MiniForm action={(v) => adjustStock(assetId, v)} submitLabel={direction === "IN" ? "Add stock" : "Remove from stock"} onDone={() => setCount(1)}>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="direction" value="IN" checked={direction === "IN"} onChange={() => setDirection("IN")} /> Bought more</label>
        <label className="flex items-center gap-2"><input type="radio" name="direction" value="OUT" checked={direction === "OUT"} onChange={() => setDirection("OUT")} /> Used up / broken / thrown away</label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={direction === "OUT" ? `How many (${available} in stock)` : "How many"} required>
          <Input name="count" type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label="Note" required={direction === "OUT"}><Input name="note" /></Field>
      </div>
      {direction === "IN" && <PurchaseFields options={options} count={count} />}
    </MiniForm>
  );
}

export function NotePanel({ assetId }: { assetId: string }) {
  const [key, setKey] = useState(0);
  return (
    <MiniForm key={key} action={(v) => addAssetNote(assetId, String(v.note ?? ""))} submitLabel="Add note" variant="outline" onDone={() => setKey((k) => k + 1)}>
      <Textarea name="note" rows={2} placeholder="Anything worth remembering about this item." />
    </MiniForm>
  );
}
