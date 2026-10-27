"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { importProspectBatch, saveDataset, type ImportBatchResult, type ProspectImportRow } from "@/server/prospects";

/**
 * Reads a spreadsheet in the browser and sends it to the server in batches,
 * so a file of a hundred thousand rows goes through without one huge request.
 * Brought over from ORMS's importer: columns are recognised by what they
 * contain as well as their heading, and nothing is thrown away - a column
 * not mapped to a field is kept on the prospect as an extra field.
 */

const TARGETS = {
  businessName: "Business name",
  website: "Website",
  phone: "Phone",
  email: "Email",
  industry: "Industry / category",
  street: "Address",
  city: "City",
  region: "Region / province",
  country: "Country",
  icpTier: "ICP tier",
  googleRating: "Google rating",
  googleReviewCount: "Google reviews",
  googleMapsUrl: "Google Maps link",
  tag: "Tag",
  custom: "Keep as extra field",
  skip: "Don't import",
} as const;
type Target = keyof typeof TARGETS;

const BATCH = 500;
type Row = Record<string, string>;

function guessTarget(header: string, values: string[]): Target {
  const h = header.toLowerCase();
  const sample = values.filter(Boolean).slice(0, 40);
  const share = (re: RegExp) => (sample.length ? sample.filter((v) => re.test(v.trim())).length / sample.length : 0);
  if (/maps|google.*link/.test(h) || share(/google\.[a-z.]+\/maps/i) > 0.5) return "googleMapsUrl";
  if (share(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/) > 0.6 || /e-?mail/.test(h)) return "email";
  if (/web|site|url/.test(h) || share(/^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i) > 0.6) return "website";
  if (/phone|mobile|tel|contact no/.test(h) && !/class|type/.test(h)) return "phone";
  if (/^name$|business|company|clinic|practice/.test(h)) return "businessName";
  if (/categor|industry|type of business/.test(h)) return "industry";
  if (/address|street/.test(h)) return "street";
  if (/^city|town/.test(h)) return "city";
  if (/region|province|state|area/.test(h)) return "region";
  if (/country/.test(h)) return "country";
  if (/icp|tier/.test(h)) return "icpTier";
  if (/rating|stars/.test(h)) return "googleRating";
  if (/review/.test(h)) return "googleReviewCount";
  if (/^tags?$/.test(h)) return "tag";
  return "custom";
}

const num = (v: string) => { const n = Number(String(v).replace(/[^\d.]/g, "")); return v.trim() && Number.isFinite(n) ? n : null; };

export function ProspectImporter({ datasets }: { datasets: { id: string; name: string }[] }) {
  const [fileName, setFileName] = useState("");
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheet, setSheet] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [datasetId, setDatasetId] = useState("");
  const [newDataset, setNewDataset] = useState("");
  const [extraTag, setExtraTag] = useState("");
  const [matchOn, setMatchOn] = useState<("website" | "phone" | "email" | "name")[]>(["website", "phone", "email"]);
  const [duplicates, setDuplicates] = useState<"skip" | "update">("skip");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [summary, setSummary] = useState<ImportBatchResult | null>(null);

  function loadSheet(wb: XLSX.WorkBook, name: string) {
    const data = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: "", raw: false });
    const cols = data.length ? Object.keys(data[0]) : [];
    setSheet(name);
    setRows(data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "").trim()]))));
    setHeaders(cols);
    const guessed = Object.fromEntries(cols.map((c) => [c, guessTarget(c, data.slice(0, 60).map((r) => String(r[c] ?? "")))])) as Record<string, Target>;
    // One business-name column: the best guess, else the most text-like column.
    if (!Object.values(guessed).includes("businessName") && cols.length) {
      const textish = cols.filter((c) => guessed[c] === "custom")
        .map((c) => ({ c, n: data.slice(0, 50).filter((r) => /[a-z]{3,}/i.test(String(r[c] ?? ""))).length }))
        .sort((a, b) => b.n - a.n)[0];
      if (textish) guessed[textish.c] = "businessName";
    }
    setTargets(guessed);
    setSummary(null);
    setDone(0);
  }

  async function onFile(file: File) {
    setError(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      setFileName(file.name);
      setWorkbook(wb);
      const best = wb.SheetNames.map((n) => ({ n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n]).length })).sort((a, b) => b.rows - a.rows)[0];
      loadSheet(wb, best?.n ?? wb.SheetNames[0]);
    } catch {
      setError("That file could not be read. Use an Excel (.xlsx, .xls) or CSV file.");
    }
  }

  const nameColumn = headers.find((h) => targets[h] === "businessName");
  const prepared: ProspectImportRow[] = useMemo(() => rows.flatMap((r) => {
    const name = nameColumn ? r[nameColumn] : "";
    if (!name) return [];
    const row: ProspectImportRow = { businessName: name.slice(0, 300), phones: [], emails: [], tags: extraTag.trim() ? [extraTag.trim()] : [], customFields: {} };
    for (const h of headers) {
      const v = r[h];
      if (!v || v === "·") continue;
      const t = targets[h];
      if (t === "phone") row.phones!.push(...v.split(/[,;/]| or /).map((x) => x.trim()).filter(Boolean));
      else if (t === "email") row.emails!.push(...v.split(/[,;\s]+/).filter((x) => x.includes("@")));
      else if (t === "tag") row.tags!.push(...v.split(/[,;]/).map((x) => x.trim()).filter(Boolean));
      else if (t === "googleRating") { const n = num(v); if (n != null && n <= 5) row.googleRating = n; }
      else if (t === "googleReviewCount") { const n = num(v); if (n != null) row.googleReviewCount = Math.round(n); }
      else if (t === "custom") row.customFields![h] = v.slice(0, 5000);
      else if (t !== "skip" && t !== "businessName") (row as Record<string, unknown>)[t] = v;
    }
    return [row];
  }), [rows, headers, targets, nameColumn, extraTag]);

  async function run() {
    setError(null);
    setSummary(null);
    let id = datasetId;
    if (!id) {
      if (!newDataset.trim()) { setError("Please fill in: Dataset."); return; }
      const created = await saveDataset(null, { name: newDataset.trim(), description: `Imported from ${fileName}${sheet ? ` › ${sheet}` : ""}` });
      if (!created.ok) { setError(created.error); return; }
      id = created.data.id;
      setDatasetId(id);
    }
    setRunning(true);
    const total: ImportBatchResult = { imported: 0, updated: 0, skipped: 0, invalid: rows.length - prepared.length, errors: [] };
    for (let i = 0; i < prepared.length; i += BATCH) {
      const result = await importProspectBatch({
        datasetId: id, source: sheet ? `${fileName} › ${sheet}` : fileName, matchOn, duplicates, rows: prepared.slice(i, i + BATCH),
      });
      if (!result.ok) { total.errors.push(`Rows ${i + 1}–${i + BATCH}: ${result.error}`); }
      else {
        total.imported += result.data.imported; total.updated += result.data.updated; total.skipped += result.data.skipped;
        total.errors.push(...result.data.errors);
      }
      setDone(Math.min(prepared.length, i + BATCH));
    }
    setRunning(false);
    setSummary(total);
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader><CardTitle>1. The file</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input type="file" accept=".xlsx,.xls,.csv" aria-label="Spreadsheet file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          {workbook && workbook.SheetNames.length > 1 && (
            <Field label="Sheet">
              <Select value={sheet} onChange={(e) => loadSheet(workbook, e.target.value)}>
                {workbook.SheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Field>
          )}
          {rows.length > 0 && <p className="text-sm text-muted-foreground">{rows.length.toLocaleString()} rows in “{sheet}”.</p>}
        </CardContent>
      </Card>

      {headers.length > 0 && (
        <Card>
          <CardHeader><CardTitle>2. What each column is</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead><TR><TH>Column</TH><TH>Example</TH><TH>Import as</TH></TR></THead>
              <TBody>
                {headers.map((h) => (
                  <TR key={h}>
                    <TD className="font-medium">{h}</TD>
                    <TD className="max-w-xs truncate text-sm text-muted-foreground">{rows.find((r) => r[h])?.[h] ?? ""}</TD>
                    <TD>
                      <Select aria-label={`Import ${h} as`} value={targets[h]} onChange={(e) => {
                        const t = e.target.value as Target;
                        setTargets((prev) => {
                          const next = { ...prev, [h]: t };
                          // Only one column can be the business name.
                          if (t === "businessName") for (const k of Object.keys(next)) if (k !== h && next[k] === "businessName") next[k] = "custom";
                          return next;
                        });
                      }} className="w-56">
                        {(Object.keys(TARGETS) as Target[]).map((t) => <option key={t} value={t}>{TARGETS[t]}</option>)}
                      </Select>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {!nameColumn && <div className="p-4"><Alert tone="warning">Choose which column is the business name.</Alert></div>}
          </CardContent>
        </Card>
      )}

      {nameColumn && (
        <Card>
          <CardHeader><CardTitle>3. Where it goes</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Dataset" required help="The list these prospects belong to. Pick an existing one, or name a new one.">
              <Select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                <option value="">New dataset…</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            {!datasetId && (
              <Field label="New dataset name" required>
                <Input value={newDataset} onChange={(e) => setNewDataset(e.target.value)} placeholder={fileName.replace(/\.[^.]+$/, "")} />
              </Field>
            )}
            <Field label="Tag every row with" hint="Optional.">
              <Input value={extraTag} onChange={(e) => setExtraTag(e.target.value)} placeholder="e.g. Dentists Toronto" />
            </Field>
            <Field label="The same business, if it has the same">
              <div className="flex flex-wrap gap-3 pt-2 text-sm">
                {(["website", "phone", "email", "name"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={matchOn.includes(k)} onChange={(e) => setMatchOn((m) => e.target.checked ? [...m, k] : m.filter((x) => x !== k))} />
                    {k === "name" ? "business name" : k}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="When it is already here">
              <Select value={duplicates} onChange={(e) => setDuplicates(e.target.value as "skip" | "update")}>
                <option value="skip">Skip it</option>
                <option value="update">Update it with this file's details</option>
              </Select>
            </Field>
          </CardContent>
        </Card>
      )}

      {nameColumn && (
        <Card>
          <CardHeader><CardTitle>4. Import</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              {prepared.length.toLocaleString()} prospects ready
              {rows.length - prepared.length > 0 && <span className="text-muted-foreground"> · {(rows.length - prepared.length).toLocaleString()} rows have no business name and will be left out</span>}
            </p>
            <Button onClick={run} disabled={running || !prepared.length}>{running ? `Importing… ${done.toLocaleString()} of ${prepared.length.toLocaleString()}` : `Import ${prepared.length.toLocaleString()} prospects`}</Button>
            {running && (
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${(done / Math.max(1, prepared.length)) * 100}%` }} />
              </div>
            )}
            {summary && (
              <Alert tone={summary.errors.length ? "warning" : "success"}>
                <p>
                  Imported {summary.imported.toLocaleString()} new, updated {summary.updated.toLocaleString()}, skipped {summary.skipped.toLocaleString()} already here
                  {summary.invalid ? `, left out ${summary.invalid.toLocaleString()} without a business name` : ""}.
                </p>
                {summary.errors.slice(0, 5).map((e) => <p key={e} className="mt-1 text-xs">{e}</p>)}
                <p className="mt-2"><a className="font-medium underline" href={`/prospects?datasetId=${datasetId}`}>Open the dataset</a></p>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
