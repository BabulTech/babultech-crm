"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Star, Trash2, Plus, Pencil } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import {
  addProspectEmail, addProspectPhone, changeProspectDetail, saveProspectPerson, tagProspects, updateProspect,
} from "@/server/prospects";

type Result = { ok: true } | { ok: false; error: string };

/** Runs a save and refreshes the data in place on success; shows the error otherwise. */
function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<Result>) => {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };
  return { pending, error, run };
}

// ---------------------------------------------------------------- phones/emails

export function ContactPoints({ prospectId, phones, emails, canWrite }: {
  prospectId: string;
  phones: { id: string; phone: string; label: string | null; phoneClass: string | null; phoneType: string | null; isPrimary: boolean }[];
  emails: { id: string; email: string; isPrimary: boolean }[];
  canWrite: boolean;
}) {
  const { pending, error, run } = useSave();
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");

  const row = (kind: "phone" | "email", id: string, text: React.ReactNode, isPrimary: boolean, href: string) => (
    <li key={id} className="flex items-center gap-2 py-1.5 text-sm">
      <a href={href} className="font-medium hover:underline">{text}</a>
      {isPrimary && <Badge tone="info">Primary</Badge>}
      {canWrite && (
        <span className="ml-auto flex gap-1">
          {!isPrimary && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={pending}
              onClick={() => run(() => changeProspectDetail(kind, id, "primary"))} aria-label="Make primary" title="Make primary">
              <Star className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={pending}
            onClick={() => run(() => changeProspectDetail(kind, id, "remove"))} aria-label="Remove" title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
    </li>
  );

  return (
    <Card>
      <CardHeader><CardTitle>How to reach them</CardTitle></CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Phones</p>
          <ul className="divide-y">
            {phones.length ? phones.map((p) => row("phone", p.id, <>
              {p.phone}
              {(p.label || p.phoneClass || p.phoneType) && <span className="ml-1 text-xs font-normal text-muted-foreground">{[p.label, p.phoneType, p.phoneClass].filter(Boolean).join(" · ")}</span>}
            </>, p.isPrimary, `tel:${p.phone.replace(/[^\d+]/g, "")}`)) : <li className="py-1.5 text-sm text-muted-foreground">None yet</li>}
          </ul>
          {canWrite && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => addProspectPhone(prospectId, phone, label)); }}>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 416 555 0100" aria-label="New phone" className="h-8" />
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" aria-label="Phone label" className="h-8 w-28" />
              <Button type="submit" size="sm" disabled={pending || !phone.trim()}><Plus className="h-4 w-4" /></Button>
            </form>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Emails</p>
          <ul className="divide-y">
            {emails.length ? emails.map((e) => row("email", e.id, e.email, e.isPrimary, `mailto:${e.email}`)) : <li className="py-1.5 text-sm text-muted-foreground">None yet</li>}
          </ul>
          {canWrite && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => addProspectEmail(prospectId, email)); }}>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@business.com" aria-label="New email" className="h-8" />
              <Button type="submit" size="sm" disabled={pending || !email.trim()}><Plus className="h-4 w-4" /></Button>
            </form>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- people

interface Person {
  id: string; name: string; role: string | null; email: string | null; phone: string | null;
  personalEmail: string | null; personalPhone: string | null; linkedinUrl: string | null; isPrimary: boolean; notes: string | null;
}

const ROLES = ["Owner", "Manager", "Director", "Office manager", "Receptionist", "Marketing", "Other"];

export function PeoplePanel({ prospectId, people, canWrite }: { prospectId: string; people: Person[]; canWrite: boolean }) {
  const { pending, error, run } = useSave();
  const [editing, setEditing] = useState<string | "new" | null>(null);

  function submit(personId: string | null, form: FormData) {
    const get = (k: string) => String(form.get(k) ?? "");
    run(() => saveProspectPerson(prospectId, personId, {
      name: get("name"), role: get("role"), email: get("email"), phone: get("phone"),
      personalEmail: get("personalEmail"), personalPhone: get("personalPhone"), linkedinUrl: get("linkedinUrl"),
      notes: get("notes"), isPrimary: form.get("isPrimary") === "on",
    }));
  }

  const form = (p: Person | null) => (
    <form className="grid gap-3 rounded-md border border-dashed p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(p?.id ?? null, new FormData(e.currentTarget)); }}>
      <Field label="Name" required><Input name="name" defaultValue={p?.name ?? ""} required /></Field>
      <Field label="Role">
        <Input name="role" list="prospect-roles" defaultValue={p?.role ?? ""} placeholder="Owner" />
        <datalist id="prospect-roles">{ROLES.map((r) => <option key={r} value={r} />)}</datalist>
      </Field>
      <Field label="Work email"><Input name="email" type="email" defaultValue={p?.email ?? ""} /></Field>
      <Field label="Work phone"><Input name="phone" defaultValue={p?.phone ?? ""} /></Field>
      <Field label="Personal email"><Input name="personalEmail" type="email" defaultValue={p?.personalEmail ?? ""} /></Field>
      <Field label="Personal phone"><Input name="personalPhone" defaultValue={p?.personalPhone ?? ""} /></Field>
      <Field label="LinkedIn"><Input name="linkedinUrl" defaultValue={p?.linkedinUrl ?? ""} placeholder="https://www.linkedin.com/in/…" /></Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="isPrimary" defaultChecked={p?.isPrimary ?? people.length === 0} /> Main contact</label>
      <div className="sm:col-span-2"><Field label="Notes"><Textarea name="notes" rows={2} defaultValue={p?.notes ?? ""} /></Field></div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
      </div>
    </form>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Decision makers</CardTitle>
        {canWrite && editing === null && <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add person</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {editing === "new" && form(null)}
        {people.length === 0 && editing !== "new" && <p className="text-sm text-muted-foreground">Nobody recorded yet. Add the owner or manager once you know who decides.</p>}
        {people.map((p) => editing === p.id ? <div key={p.id}>{form(p)}</div> : (
          <div key={p.id} className="flex items-start gap-3 border-b pb-3 text-sm last:border-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{p.name}{p.role && <span className="font-normal text-muted-foreground"> · {p.role}</span>} {p.isPrimary && <Badge tone="info">Main contact</Badge>}</p>
              <p className="text-muted-foreground">
                {[p.phone, p.email, p.personalPhone && `${p.personalPhone} (personal)`, p.personalEmail && `${p.personalEmail} (personal)`].filter(Boolean).join(" · ") || "No contact details"}
              </p>
              {p.linkedinUrl && <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">LinkedIn</a>}
              {p.notes && <p className="mt-1 whitespace-pre-wrap">{p.notes}</p>}
            </div>
            {canWrite && (
              <span className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditing(p.id)} aria-label={`Edit ${p.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={pending}
                  onClick={() => { if (window.confirm(`Remove ${p.name}?`)) run(() => changeProspectDetail("person", p.id, "remove")); }} aria-label={`Remove ${p.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- tags

export function TagEditor({ prospectId, tags, canWrite }: { prospectId: string; tags: string[]; canWrite: boolean }) {
  const { pending, error, run } = useSave();
  const [tag, setTag] = useState("");
  return (
    <Card>
      <CardHeader><CardTitle>Tags</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap gap-1">
          {tags.length ? tags.map((t) => (
            <Badge key={t} tone="neutral">
              {t}
              {canWrite && <button type="button" className="ml-1 opacity-60 hover:opacity-100" aria-label={`Remove tag ${t}`} disabled={pending}
                onClick={() => run(async () => { const r = await tagProspects([prospectId], [], [t]); return r.ok ? { ok: true } : r; })}>×</button>}
            </Badge>
          )) : <span className="text-sm text-muted-foreground">No tags</span>}
        </div>
        {canWrite && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await tagProspects([prospectId], [tag]); return r.ok ? { ok: true } : r; }); }}>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add a tag" aria-label="New tag" className="h-8" />
            <Button type="submit" size="sm" disabled={pending || !tag.trim()}>Add</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- business details

interface EditableProspect {
  id: string; businessName: string; website: string | null; industry: string | null; street: string | null; city: string | null;
  region: string | null; country: string | null; icpTier: string | null; googleRating: number | null; googleReviewCount: number | null;
  googleMapsUrl: string | null; datasetId: string | null;
}

export function ProspectEditor({ prospect: p, datasets }: { prospect: EditableProspect; datasets: { id: string; name: string }[] }) {
  const { pending, error, run } = useSave();
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="outline" className="w-full" onClick={() => setOpen(true)}><Pencil className="h-4 w-4" /> Edit business details</Button>;
  return (
    <Card>
      <CardHeader><CardTitle>Edit business details</CardTitle></CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const get = (k: string) => String(f.get(k) ?? "");
          run(() => updateProspect(p.id, {
            businessName: get("businessName"), website: get("website"), industry: get("industry"), street: get("street"), city: get("city"),
            region: get("region"), country: get("country"), icpTier: get("icpTier"), googleRating: get("googleRating") as never,
            googleReviewCount: get("googleReviewCount") as never, googleMapsUrl: get("googleMapsUrl"), datasetId: get("datasetId"),
          }));
        }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Business name" required><Input name="businessName" defaultValue={p.businessName} required /></Field>
          <Field label="Website"><Input name="website" defaultValue={p.website ?? ""} /></Field>
          <Field label="Industry"><Input name="industry" defaultValue={p.industry ?? ""} /></Field>
          <Field label="Street"><Input name="street" defaultValue={p.street ?? ""} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City"><Input name="city" defaultValue={p.city ?? ""} /></Field>
            <Field label="Region"><Input name="region" defaultValue={p.region ?? ""} /></Field>
          </div>
          <Field label="Country"><Input name="country" defaultValue={p.country ?? ""} /></Field>
          <Field label="ICP tier"><Input name="icpTier" defaultValue={p.icpTier ?? ""} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Google rating"><Input name="googleRating" type="number" min="0" max="5" step="0.1" defaultValue={p.googleRating ?? ""} /></Field>
            <Field label="Reviews"><Input name="googleReviewCount" type="number" min="0" step="1" defaultValue={p.googleReviewCount ?? ""} /></Field>
          </div>
          <Field label="Google Maps link"><Input name="googleMapsUrl" defaultValue={p.googleMapsUrl ?? ""} /></Field>
          <Field label="Dataset">
            <Select name="datasetId" defaultValue={p.datasetId ?? ""}>
              <option value="">None</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
