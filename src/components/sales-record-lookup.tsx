"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui";
import { SALES_TYPE_LABEL, type SalesType } from "@/lib/sales-types";
import { cn } from "@/lib/utils";

const SHOWN = 30;

/** Type to find one of your prospects, leads, deals or accounts by name. */
export function SalesRecordLookup({ records, value, onChange }: {
  records: { type: string; id: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const selected = records.find((r) => `${r.type}:${r.id}` === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? records.filter((r) => r.label.toLowerCase().includes(q)) : records).slice(0, SHOWN);
  }, [query, records]);

  return (
    <div className="relative">
      <Input
        aria-label="Sales record"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        placeholder={records.length ? "Type a name…" : "You do not own any open prospects, leads, deals or accounts"}
        disabled={!records.length}
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(""); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length > 0 && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {matches.map((r) => (
            <li key={`${r.type}:${r.id}`} role="option" aria-selected={`${r.type}:${r.id}` === value}>
              <button
                type="button"
                className={cn("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent", `${r.type}:${r.id}` === value && "bg-accent")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(`${r.type}:${r.id}`); setQuery(r.label); setOpen(false); }}
              >
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{SALES_TYPE_LABEL[r.type as SalesType]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && matches.length === 0 && (
        <p className="absolute z-20 mt-1 w-full rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md">None of your records match.</p>
      )}
    </div>
  );
}
