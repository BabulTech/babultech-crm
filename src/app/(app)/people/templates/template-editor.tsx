"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { saveTemplate } from "@/server/people";
import { BoldButton } from "@/components/bold-button";
import { CONTRACT_TYPES, CONTRACT_TYPE_LABELS, TEMPLATE_PLACEHOLDERS, type ContractType } from "@/lib/people";

type Template = { id: string; name: string; contractType: string; body: string; active: boolean };

export function TemplateEditor({ templates }: { templates: Template[] }) {
  const [editing, setEditing] = useState<Template | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(form: FormData) {
    setError(null);
    start(async () => {
      const result = await saveTemplate({
        id: editing?.id || null,
        name: String(form.get("templateName")),
        contractType: String(form.get("templateType")),
        body: String(form.get("templateBody")),
        active: form.get("templateActive") === "on",
      });
      if (!result.ok) { setError(result.error); return; }
      softReload();
    });
  }

  if (editing) {
    return (
      <Card>
        <CardHeader><CardTitle>{editing.id ? `Edit ${editing.name}` : "New template"}</CardTitle></CardHeader>
        <CardContent>
          <form action={save} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required><Input name="templateName" defaultValue={editing.name} required /></Field>
              <Field label="For" required>
                <Select name="templateType" defaultValue={editing.contractType}>
                  {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{CONTRACT_TYPE_LABELS[t]}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <BoldButton target={() => document.querySelector<HTMLTextAreaElement>('textarea[name="templateBody"]')} />
              <span className="text-xs text-muted-foreground">Select words and press Bold; they print in bold on every contract made from this template.</span>
            </div>
            <Field label="Wording" required hint="Plain text. Blank lines separate paragraphs. **Double asterisks** make words bold.">
              <Textarea name="templateBody" rows={26} className="font-serif text-sm" defaultValue={editing.body} required />
            </Field>
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <p className="mb-1 font-medium">Filled in from the profile and contract:</p>
              <p className="font-mono leading-6">{TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join("  ")}</p>
              <p className="mt-1 text-muted-foreground">Anything missing prints as a line to fill in by hand.</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="templateActive" defaultChecked={editing.active} /> In use (offered when preparing a contract)
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save template"}</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing({ id: "", name: "", contractType: "INTERNSHIP", body: "", active: true })}>New template</Button>
      </div>
      {templates.map((t) => (
        <Card key={t.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">{t.name} {!t.active && <Badge tone="neutral">Not in use</Badge>}</p>
              <p className="text-sm text-muted-foreground">{CONTRACT_TYPE_LABELS[t.contractType as ContractType]}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setEditing(t)}>Edit</Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
