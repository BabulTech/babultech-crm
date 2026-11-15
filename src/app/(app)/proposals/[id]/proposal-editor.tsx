"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2, Send, Copy, FilePlus2 } from "lucide-react";
import { Button, Alert, Input, Select, Textarea, Field, Card, CardHeader, CardTitle, CardContent } from "@/components/ui";
import { RichTextEditor } from "@/components/rich-text-editor";
import { saveProposal, sendProposal, newProposalVersion } from "@/server/proposals";
import { MERGE_FIELDS } from "@/lib/proposals";

type Section = { key: number; kind: "TEXT" | "PRICING"; title: string; body?: string };

let counter = 0;

export function ProposalEditor({
  id,
  title,
  validUntil,
  quotationId,
  sections: initial,
  quotations,
}: {
  id: string;
  title: string;
  validUntil: string | null;
  quotationId: string | null;
  sections: { kind: "TEXT" | "PRICING"; title: string; body?: string }[];
  quotations: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [sections, setSections] = useState<Section[]>(() => initial.map((s) => ({ ...s, key: ++counter })));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const move = (i: number, d: -1 | 1) => setSections((list) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  return (
    <form
      className="space-y-5"
      data-proposal-editor
      action={(fd) => {
        setError(null); setSaved(false);
        const payload = {
          title: String(fd.get("title") ?? ""),
          validUntil: String(fd.get("validUntil") ?? ""),
          quotationId: String(fd.get("quotationId") ?? "") || null,
          sections: sections.map((s) => s.kind === "PRICING"
            ? { kind: "PRICING" as const, title: String(fd.get(`title_${s.key}`) ?? s.title) }
            : { kind: "TEXT" as const, title: String(fd.get(`title_${s.key}`) ?? s.title), body: String(fd.get(`body_${s.key}`) ?? "") }),
        };
        start(async () => {
          const r = await saveProposal(id, payload);
          if (!r.ok) { setError(r.error); return; }
          setSaved(true);
          router.refresh();
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Saved. The preview below shows the new version.</Alert>}
      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <div className="sm:col-span-3"><Field label="Title" required><Input name="title" defaultValue={title} required /></Field></div>
          <Field label="Valid until" required><Input name="validUntil" type="date" defaultValue={validUntil ?? ""} required /></Field>
          <div className="sm:col-span-2">
            <Field label="Quotation for the pricing section" help="The pricing table is this quotation's lines and totals. Sending the proposal sends the quotation too, so it must be approved if its discounts need approval.">
              <Select name="quotationId" defaultValue={quotationId ?? ""}>
                <option value="">None</option>
                {quotations.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
              </Select>
            </Field>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        You can still use fill-in fields while editing, e.g. {"{{account.name}}"}; they were filled in when the proposal was created.
        Available: {MERGE_FIELDS.map((m) => `{{${m.field}}}`).join(", ")}.
      </p>

      {sections.map((s, i) => (
        <Card key={s.key} data-section={i}>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0 p-4">
            <Input name={`title_${s.key}`} defaultValue={s.title} aria-label="Section title" className="flex-1 font-semibold" />
            <Button type="button" size="icon" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => move(i, 1)} disabled={i === sections.length - 1} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => setSections((l) => l.filter((x) => x.key !== s.key))} aria-label="Remove section"><Trash2 className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {s.kind === "PRICING"
              ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Pricing table: the chosen quotation&apos;s lines and totals.</p>
              : <RichTextEditor name={`body_${s.key}`} defaultValue={s.body ?? ""} rows={6} />}
          </CardContent>
        </Card>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setSections((l) => [...l, { key: ++counter, kind: "TEXT", title: "New section", body: "" }])}><Plus className="h-4 w-4" /> Text section</Button>
        {!sections.some((s) => s.kind === "PRICING") && (
          <Button type="button" variant="outline" onClick={() => setSections((l) => [...l, { key: ++counter, kind: "PRICING", title: "Pricing" }])}><Plus className="h-4 w-4" /> Pricing table</Button>
        )}
        <div className="flex-1" />
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

export function SendPanel({ id, contacts }: { id: string; contacts: { id: string; name: string; email: string }[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(contacts.slice(0, 1).map((c) => c.id));
  const [extra, setExtra] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; sentTo: string[] } | null>(null);
  const [pending, start] = useTransition();

  if (result) {
    return (
      <div className="space-y-3" data-send-result>
        <Alert tone="success">{result.sentTo.length ? `Sent to ${result.sentTo.join(", ")}.` : "The link was created but the email failed. Share the link below yourself."}</Alert>
        <Field label="Customer link (shown once)">
          <div className="flex gap-2">
            <Input readOnly value={result.url} data-customer-link />
            <Button type="button" variant="outline" onClick={() => navigator.clipboard.writeText(result.url)}><Copy className="h-4 w-4" /> Copy</Button>
          </div>
        </Field>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Send to">
        <div className="space-y-1">
          {contacts.length === 0 && <p className="text-sm text-muted-foreground">No contacts with an email on this account. Add an address below.</p>}
          {contacts.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen((l) => e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id))} />
              {c.name} <span className="text-muted-foreground">{c.email}</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="Other addresses" hint="Comma separated."><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="cfo@customer.com" /></Field>
      <Field label="Message" hint="Optional - a default message is used otherwise."><Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const r = await sendProposal(id, { contactIds: chosen, extraEmails: extra.split(",").map((s) => s.trim()).filter(Boolean), message: message.trim() || null });
            if (!r.ok) { setError(r.error); return; }
            setResult(r.data);
            router.refresh();
          });
        }}
      >
        <Send className="h-4 w-4" /> {pending ? "Sending…" : "Send to customer"}
      </Button>
      <p className="text-xs text-muted-foreground">Sending freezes this version and sends its quotation. Save your edits first.</p>
    </div>
  );
}

export function NewVersionButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button variant="outline" disabled={pending} onClick={() => start(async () => {
        const r = await newProposalVersion(id);
        if (r.ok) router.push(`/proposals/${r.data.id}`); else setError(r.error);
      })}>
        <FilePlus2 className="h-4 w-4" /> New version
      </Button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </>
  );
}
