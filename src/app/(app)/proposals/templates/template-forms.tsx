"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Alert, Input, Select, Field, Card, CardHeader, CardContent } from "@/components/ui";
import { RichTextEditor } from "@/components/rich-text-editor";
import { saveProposalTemplate, saveProposalSection } from "@/server/proposals";
import { MERGE_FIELDS } from "@/lib/proposals";

type Kind = "TEXT" | "LIBRARY" | "PRICING";
type Row = { key: number; kind: Kind; title: string; body?: string; sectionId?: string };
let counter = 0;

export function FieldList() {
  return (
    <p className="text-xs text-muted-foreground">
      Fill-in fields (typed into any text): {MERGE_FIELDS.map((m) => <code key={m.field} className="mr-1 rounded bg-muted px-1" title={m.label}>{`{{${m.field}}}`}</code>)}
    </p>
  );
}

export function TemplateEditor({
  id, offerings, library, defaults,
}: {
  id: string | null;
  offerings: { id: string; name: string }[];
  library: { id: string; name: string }[];
  defaults: { name: string; offeringId: string | null; validDays: number; active: boolean; sections: { kind: Kind; title: string; body?: string; sectionId?: string }[] };
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => defaults.sections.map((s) => ({ ...s, key: ++counter })));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const move = (i: number, d: -1 | 1) => setRows((l) => { const j = i + d; if (j < 0 || j >= l.length) return l; const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const add = (kind: Kind) => setRows((l) => [...l, { key: ++counter, kind, title: kind === "PRICING" ? "Pricing" : kind === "LIBRARY" ? "Shared section" : "New section", body: "", sectionId: library[0]?.id }]);

  return (
    <form className="space-y-5" action={(fd) => {
      setError(null); setSaved(false);
      const payload = {
        name: String(fd.get("name") ?? ""),
        offeringId: String(fd.get("offeringId") ?? "") || null,
        validDays: String(fd.get("validDays") ?? "30"),
        active: fd.get("active") === "on",
        sections: rows.map((r) => {
          const title = String(fd.get(`title_${r.key}`) ?? r.title);
          if (r.kind === "TEXT") return { kind: "TEXT", title, body: String(fd.get(`body_${r.key}`) ?? "") };
          if (r.kind === "LIBRARY") return { kind: "LIBRARY", title, sectionId: String(fd.get(`section_${r.key}`) ?? "") };
          return { kind: "PRICING", title };
        }),
      };
      start(async () => {
        const r = await saveProposalTemplate(id, payload);
        if (!r.ok) { setError(r.error); return; }
        if (!id) router.push(`/proposals/templates/${r.data.id}`); else { setSaved(true); router.refresh(); }
      });
    }}>
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Saved. New proposals use it from now on.</Alert>}
      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Name" required><Input name="name" defaultValue={defaults.name} required /></Field>
          <Field label="Offering" help="Deals with this offering get this template by default.">
            <Select name="offeringId" defaultValue={defaults.offeringId ?? ""}>
              <option value="">Any</option>
              {offerings.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Field label="Valid for (days)"><Input name="validDays" type="number" min={1} max={365} defaultValue={defaults.validDays} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="active" defaultChecked={defaults.active} /> In use</label>
        </CardContent>
      </Card>
      <FieldList />
      {rows.map((r, i) => (
        <Card key={r.key} data-template-section={i}>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0 p-4">
            <span className="w-20 shrink-0 text-xs font-medium uppercase text-muted-foreground">{r.kind === "TEXT" ? "Text" : r.kind === "LIBRARY" ? "Shared" : "Pricing"}</span>
            <Input name={`title_${r.key}`} defaultValue={r.title} aria-label="Section title" className="flex-1 font-semibold" />
            <Button type="button" size="icon" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => setRows((l) => l.filter((x) => x.key !== r.key))} aria-label="Remove"><Trash2 className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {r.kind === "TEXT" && <RichTextEditor name={`body_${r.key}`} defaultValue={r.body ?? ""} rows={5} />}
            {r.kind === "LIBRARY" && (
              <Select name={`section_${r.key}`} defaultValue={r.sectionId ?? ""}>
                {library.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
            {r.kind === "PRICING" && <p className="text-sm text-muted-foreground">The deal&apos;s quotation: lines, discounts, tax and total.</p>}
          </CardContent>
        </Card>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => add("TEXT")}><Plus className="h-4 w-4" /> Text</Button>
        {library.length > 0 && <Button type="button" variant="outline" onClick={() => add("LIBRARY")}><Plus className="h-4 w-4" /> Shared section</Button>}
        {!rows.some((r) => r.kind === "PRICING") && <Button type="button" variant="outline" onClick={() => add("PRICING")}><Plus className="h-4 w-4" /> Pricing table</Button>}
        <div className="flex-1" />
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : id ? "Save template" : "Create template"}</Button>
      </div>
    </form>
  );
}

export function LibrarySection({ id, name, body }: { id: string | null; name: string; body: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(!id);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  if (!open) return (
    <div className="flex items-center justify-between p-3">
      <span className="font-medium">{name}</span>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Edit</Button>
    </div>
  );
  return (
    <form key={key} className="space-y-2 p-3" action={(fd) => start(async () => {
      setError(null);
      const r = await saveProposalSection(id, { name: String(fd.get("name") ?? ""), body: String(fd.get("body") ?? "") });
      if (!r.ok) { setError(r.error); return; }
      if (id) setOpen(false); else setKey((k) => k + 1);
      router.refresh();
    })}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Input name="name" defaultValue={name} placeholder="Section name, e.g. Warranty" />
      <RichTextEditor name="body" defaultValue={body} rows={4} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{id ? "Save" : "Add shared section"}</Button>
        {id && <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>}
      </div>
    </form>
  );
}
