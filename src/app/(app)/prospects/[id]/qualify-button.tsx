"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { ArrowRightCircle } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Select, Textarea } from "@/components/ui";
import { qualifyProspect } from "@/server/prospect-qualify";

/** Hands a prospect to sales as a CRM lead. */
export function QualifyButton({ prospectId, campaignId, people, owners, canOpenLeads }: {
  prospectId: string;
  campaignId: string | null;
  people: { id: string; name: string; role: string | null; isPrimary: boolean }[];
  owners: { id: string; fullName: string; jobTitle: string | null }[];
  canOpenLeads: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const primary = people.find((p) => p.isPrimary) ?? (people.length === 1 ? people[0] : null);

  if (done) return <Alert tone="success">Qualified and handed to sales as {done}.</Alert>;
  if (!open) {
    return (
      <Button className="w-full" onClick={() => setOpen(true)}>
        <ArrowRightCircle className="h-4 w-4" /> Qualify as lead
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Qualify as lead</CardTitle></CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          start(async () => {
            const r = await qualifyProspect({
              prospectId, campaignId, ownerUserId: String(f.get("ownerUserId") ?? ""), personId: String(f.get("personId") ?? ""), note: String(f.get("note") ?? ""),
            });
            if (!r.ok) { setError(r.error); return; }
            if (canOpenLeads) softGo(`/leads/${r.data.leadId}`);
            else setDone(r.data.leadNumber);
          });
        }}>
          <p className="text-sm text-muted-foreground">
            This creates a sales lead with the business, its contact details and what marketing has logged. The prospect is then marked Qualified.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Sales owner" required help="Who in sales takes it from here.">
            <Select name="ownerUserId" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.fullName}{o.jobTitle ? ` · ${o.jobTitle}` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Contact person" help="Becomes the lead's name. Without one, the business name is used.">
            <Select name="personId" defaultValue={primary?.id ?? ""}>
              <option value="">The business</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? `, ${p.role}` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Note for sales">
            <Textarea name="note" rows={3} placeholder="Why they are a fit, what they asked for, when to call" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Handing over…" : "Create the lead"}</Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
