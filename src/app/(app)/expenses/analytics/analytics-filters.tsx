"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Input, Select } from "@/components/ui";

type Option = { value: string; label: string };

/** Filters live in the address, so a filtered chart can be bookmarked or shared. */
function useParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (key: string, values: string | string[] | null) => {
    const next = new URLSearchParams(params.toString());
    next.delete(key);
    for (const v of Array.isArray(values) ? values : values ? [values] : []) next.append(key, v);
    router.push(`${pathname}?${next.toString()}`);
  };
  return { params, set };
}

function MultiSelect({ name, label, allText, options }: { name: string; label: string; allText: string; options: Option[] }) {
  const { params, set: setParam } = useParams();
  // Ticks show at once; the chart follows when the page reloads with the filter.
  const fromUrl = params.getAll(name).join(",");
  const [chosen, setChosen] = useState<string[]>(params.getAll(name));
  const [synced, setSynced] = useState(fromUrl);
  if (synced !== fromUrl) { setSynced(fromUrl); setChosen(params.getAll(name)); }
  const set = (key: string, values: string[] | null) => { setChosen(values ?? []); setParam(key, values); };
  const summary = chosen.length === 0 ? allText : chosen.length === 1 ? options.find((o) => o.value === chosen[0])?.label ?? "1 chosen" : `${chosen.length} chosen`;
  return (
    <details className="relative" data-filter={name}>
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border bg-card px-3 text-sm">
        <span className="text-muted-foreground">{label}:</span> <span className="max-w-[160px] truncate">{summary}</span> <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-64 overflow-auto rounded-md border bg-popover p-2 shadow-md">
        {chosen.length > 0 && <button type="button" className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-primary hover:bg-muted" onClick={() => set(name, null)}>Clear - show all</button>}
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
            <input type="checkbox" checked={chosen.includes(o.value)}
              onChange={(e) => set(name, e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))} />
            {o.label}
          </label>
        ))}
      </div>
    </details>
  );
}

export function AnalyticsFilters({ categories, payers, canSeeBills, grain, colorBy }: {
  categories: Option[]; payers: Option[]; canSeeBills: boolean; grain: string; colorBy: string;
}) {
  const { params, set } = useParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2" data-analytics-filters>
      <MultiSelect name="category" label="Category" allText="All categories" options={categories} />
      <MultiSelect name="payer" label="Who paid" allText="Anyone" options={payers} />
      <MultiSelect name="approval" label="Approval" allText="All but rejected" options={[
        { value: "DRAFT", label: "Draft" }, { value: "SUBMITTED", label: "Submitted" }, { value: "APPROVED", label: "Approved" }, { value: "REJECTED", label: "Rejected" },
      ]} />
      <MultiSelect name="payment" label="Payment" allText="Paid or unpaid" options={[{ value: "UNPAID", label: "Unpaid" }, { value: "PAID", label: "Paid" }, { value: "REIMBURSED", label: "Reimbursed" }]} />
      <form onSubmit={(e) => { e.preventDefault(); set("search", search.trim() || null); }}>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search expense or number…" className="h-9 w-56" aria-label="Search expenses" />
      </form>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Group by</span>
        <Select aria-label="Group by" value={grain} onChange={(e) => set("grain", e.target.value)} className="h-9 w-28">
          <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
        </Select>
      </label>
      <div className="flex overflow-hidden rounded-md border text-sm" role="group" aria-label="Colour bars by">
        {[{ v: "category", l: "By category" }, { v: "payer", l: "By who paid" }].map((o) => (
          <button key={o.v} type="button" onClick={() => set("colorBy", o.v === "category" ? null : o.v)}
            className={`px-3 py-1.5 ${colorBy === o.v ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>{o.l}</button>
        ))}
      </div>
      {canSeeBills && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={params.get("bills") === "1"} onChange={(e) => set("bills", e.target.checked ? "1" : null)} />
          Include supplier bills
        </label>
      )}
    </div>
  );
}
