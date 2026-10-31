"use client";
import { softGo } from "@/components/soft-navigation";

import { useMemo, useState, useTransition } from "react";
import { GitMerge, Check } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { MERGE_FIELDS, MERGE_NOUN, type MergeCandidate, type MergeEntity } from "@/lib/record-merge";
import { mergeRecords } from "@/server/record-merge";
import { formatDate } from "@/lib/utils";

/**
 * Field-by-field merge of contacts or accounts, as for leads (see
 * app/(app)/leads/merge/merge-form.tsx): pick the record to keep, then the
 * value to keep wherever the records disagree.
 */
export function RecordMergeForm({ entity, records }: { entity: MergeEntity; records: MergeCandidate[] }) {
  const noun = MERGE_NOUN[entity];
  const fields = MERGE_FIELDS[entity];
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A record that cannot be merged away (a portal login, a partner) has to be
  // the one kept; otherwise the most complete, ties to the oldest.
  const suggested = useMemo(
    () =>
      records.find((r) => r.keepOnly) ??
      [...records].sort((a, b) => b.completeness - a.completeness || a.createdAt.localeCompare(b.createdAt))[0],
    [records],
  );
  const [survivorId, setSurvivorId] = useState(suggested.id);

  const initialChoices = useMemo(() => {
    const survivor = records.find((r) => r.id === survivorId)!;
    const choices: Record<string, string> = {};
    for (const f of fields) {
      choices[f.key] = survivor.values[f.key] ? survivorId : (records.find((r) => r.values[f.key])?.id ?? survivorId);
    }
    return choices;
  }, [records, survivorId, fields]);
  const [choices, setChoices] = useState(initialChoices);
  const [choiceKey, setChoiceKey] = useState(survivorId);
  if (choiceKey !== survivorId) {
    setChoiceKey(survivorId);
    setChoices(initialChoices);
  }

  const losers = records.filter((r) => r.id !== survivorId);
  const blocked = losers.find((r) => r.keepOnly);
  const contested = fields.filter((f) => new Set(records.map((r) => r.values[f.key]).filter(Boolean)).size > 1);
  const settled = fields.filter((f) => !contested.includes(f));
  const show = (r: MergeCandidate, key: string) => r.display[key] ?? r.values[key];

  function submit() {
    const survivor = records.find((r) => r.id === survivorId)!;
    if (!window.confirm(`Merge ${losers.length} ${losers.length === 1 ? noun.one : noun.many} into ${survivor.title}?\n\nEverything attached to them moves across. The merged records are retired, not deleted.`)) return;
    setError(null);
    const values: Record<string, string> = {};
    for (const f of fields) {
      const from = records.find((r) => r.id === choices[f.key]);
      if (from) values[f.key] = from.values[f.key];
    }
    start(async () => {
      const result = await mergeRecords({ entity, survivorId, loserIds: losers.map((l) => l.id), values });
      if (!result.ok) return setError(result.error);
      softGo(`${noun.path}/${result.data.survivorId}`);
    });
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Which record do you want to keep?</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            The one you keep keeps its number and owner. Everything attached to the others moves to it, and the others are retired.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {records.map((r) => (
            <label key={r.id} className={`cursor-pointer rounded-lg border p-3 transition-colors ${survivorId === r.id ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}>
              <div className="flex items-start gap-2">
                <input type="radio" name="survivor" checked={survivorId === r.id} onChange={() => setSurvivorId(r.id)} className="mt-1" aria-label={`Keep ${r.title}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.title}</p>
                  <p className="text-xs text-muted-foreground">{r.subtitle}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Created {formatDate(r.createdAt)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Badge tone="neutral">{r.completeness} fields</Badge>
                    {r.keepOnly && <Badge tone="info">{r.keepOnly}</Badge>}
                  </div>
                </div>
              </div>
            </label>
          ))}
        </CardContent>
      </Card>

      {blocked && (
        <Alert tone="warning">
          {blocked.title} {blocked.keepOnly?.toLowerCase()}, so it can only be the record kept, not merged away.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{contested.length === 0 ? "Nothing to choose between" : `${contested.length} field(s) disagree`}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {contested.length === 0 ? "No two records hold different values for the same field." : "Pick the value to keep for each."}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {contested.map((f) => (
            <div key={f.key} className="rounded-md border p-3" role="radiogroup" aria-label={f.label}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{f.label}</p>
              <div className="flex flex-wrap gap-2">
                {records.map((r) => {
                  const chosen = choices[f.key] === r.id;
                  return (
                    <label key={r.id} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${chosen ? "border-primary bg-primary/5 font-medium" : "hover:bg-muted/40"}`}>
                      <input type="radio" name={`field-${f.key}`} checked={chosen} onChange={() => setChoices((p) => ({ ...p, [f.key]: r.id }))} className="sr-only" />
                      {chosen && <Check className="mr-1 inline h-3.5 w-3.5" />}
                      {show(r, f.key) || <span className="text-muted-foreground">(empty)</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          {settled.length > 0 && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">{settled.length} field(s) with nothing to choose</summary>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                {settled.map((f) => {
                  const from = records.find((r) => r.values[f.key]);
                  return (
                    <div key={f.key} className="text-sm">
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{f.label}</dt>
                      <dd>{from ? show(from, f.key) : <span className="text-muted-foreground">—</span>}</dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={pending || Boolean(blocked)}>
          <GitMerge className="h-4 w-4" />
          {pending ? "Merging…" : `Merge ${losers.length} into this record`}
        </Button>
        <p className="text-sm text-muted-foreground">
          {entity === "contact"
            ? "Deals, cases, quotes, invoices, activities, notes, files and campaign history move across."
            : "Contacts, deals, quotes, invoices, payments, projects, cases, notes and files move across."}
        </p>
      </div>
    </div>
  );
}
