"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea } from "@/components/ui";
import { correctDocumentWording } from "@/server/corrections";

export interface WordingField {
  key: string;
  label: string;
  kind: "date" | "text" | "textarea" | "int";
  value: string;
}

/**
 * The correction form for a document the customer holds: its wording, dates
 * and references. Amounts and lines are not on it.
 */
export function WordingCorrectionForm({ type, id, fields, backTo }: { type: "Invoice" | "Quotation"; id: string; fields: WordingField[]; backTo: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const result = await correctDocumentWording({ type, id, values });
      if (!result.ok) return setError(result.error);
      softGo(backTo);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wording, dates and references</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">The amounts and lines stay as the customer has them.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {fields.map((f) => (
          <label key={f.key} className="block space-y-1.5 text-sm">
            <span className="font-medium">{f.label}</span>
            {f.kind === "textarea" ? (
              <Textarea id={`wording-${f.key}`} rows={4} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <Input
                id={`wording-${f.key}`}
                type={f.kind === "date" ? "date" : f.kind === "int" ? "number" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save correction"}</Button>
      </CardContent>
    </Card>
  );
}
