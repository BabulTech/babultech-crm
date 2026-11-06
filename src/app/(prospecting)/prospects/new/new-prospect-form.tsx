"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { softGo } from "@/components/soft-navigation";
import { createProspect } from "@/server/prospects";

const list = (v: FormDataEntryValue | null) => String(v ?? "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

export function NewProspectForm({ datasets, partner }: { datasets: { id: string; name: string }[]; partner: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(fd: FormData) {
    setError(null);
    setExisting(null);
    const get = (k: string) => String(fd.get(k) ?? "");
    start(async () => {
      const result = await createProspect({
        businessName: get("businessName"), website: get("website"), industry: get("industry"),
        city: get("city"), region: get("region"), country: get("country"), datasetId: get("datasetId"),
        phones: list(fd.get("phones")), emails: list(fd.get("emails")),
        person: { name: get("personName"), role: get("personRole"), email: get("personEmail"), phone: get("personPhone") },
      });
      if (result.ok) softGo(`/prospects/${result.data.id}`);
      else { setError(result.error); setExisting(result.existingId ?? null); }
    });
  }

  return (
    <form action={save} className="space-y-6" data-testid="new-prospect-form">
      {error && (
        <Alert tone="danger">
          {error}
          {existing && <> <Link href={`/prospects/${existing}`} className="font-medium underline">Open it</Link>.</>}
        </Alert>
      )}
      <Card>
        <CardHeader><CardTitle>The business</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Business name" required><Input name="businessName" aria-label="Business name" required /></Field>
          </div>
          <Field label="Website"><Input name="website" aria-label="Website" placeholder="example.com" /></Field>
          <Field label="Industry"><Input name="industry" aria-label="Industry" /></Field>
          <Field label="Phone numbers" help="Separate several with commas. The first is the main one."><Input name="phones" aria-label="Phone numbers" /></Field>
          <Field label="Email addresses" help="Separate several with commas. The first is the main one."><Input name="emails" aria-label="Email addresses" /></Field>
          <Field label="City"><Input name="city" aria-label="City" /></Field>
          <Field label="Region"><Input name="region" aria-label="Region" /></Field>
          <Field label="Country"><Input name="country" aria-label="Country" /></Field>
          {datasets.length > 0 && (
            <Field label="Dataset" help={partner ? "One of your own lists. Optional." : "The list it belongs to. Optional."}>
              <Select name="datasetId" aria-label="Dataset" defaultValue="">
                <option value="">None</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Contact person (optional)</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input name="personName" aria-label="Contact name" /></Field>
          <Field label="Role"><Input name="personRole" aria-label="Contact role" placeholder="Owner, Manager…" /></Field>
          <Field label="Email"><Input name="personEmail" type="email" aria-label="Contact email" /></Field>
          <Field label="Phone"><Input name="personPhone" aria-label="Contact phone" /></Field>
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2">
        <Button asChild variant="ghost"><Link href="/prospects">Cancel</Link></Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Add prospect"}</Button>
      </div>
    </form>
  );
}
