"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { Download, Upload, CheckCircle2 } from "lucide-react";
import { Button, Alert, Card, CardContent, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { importInventory, type ImportRowResult } from "@/server/inventory-import";

/** Reads the first sheet named Inventory (or the first sheet), checks it, then imports it. */
export function InventoryImporter() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [checked, setChecked] = useState<{ rows: ImportRowResult[]; items: number } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function onFile(file: File) {
    setError(null); setChecked(null); setDone(null); setFileName(file.name);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = wb.Sheets["Inventory"] ?? wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
      // Dates arrive as Date objects; send them as plain days.
      const normal = data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [
        k, v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v,
      ])));
      // The template's example rows start with "Example:" - skip them.
      const real = normal.filter((r) => !String(Object.values(r)[0] ?? "").toLowerCase().startsWith("example"));
      setRows(real);
      start(async () => {
        const result = await importInventory(real, false);
        if (result.ok) setChecked(result.data); else setError(result.error);
      });
    } catch {
      setError("That file could not be read. Save it as .xlsx or .csv and try again.");
    }
  }

  function runImport() {
    if (!rows) return;
    setError(null);
    start(async () => {
      const result = await importInventory(rows, true);
      if (!result.ok) { setError(result.error); return; }
      if (result.data.created === 0) { setChecked(result.data); return; }
      setDone(result.data.created);
    });
  }

  const problems = checked?.rows.filter((r) => r.errors.length) ?? [];

  if (done != null) {
    return (
      <Card><CardContent className="space-y-4 p-6">
        <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-5 w-5" /> Imported {done} inventory record{done === 1 ? "" : "s"}.</div>
        <div className="flex gap-2">
          <Button asChild><Link href="/inventory">Open the inventory</Link></Button>
          <Button variant="outline" onClick={() => { setDone(null); setRows(null); setChecked(null); setFileName(null); }}>Import another file</Button>
        </div>
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card><CardContent className="space-y-4 p-6">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Download the template and fill in the <strong className="text-foreground">Inventory</strong> sheet, one row per item or stock line. The Instructions and Lists sheets explain each column.</li>
          <li>Upload it here. Every row is checked first and nothing is saved until you press Import.</li>
          <li>Fix any rows marked in red in the spreadsheet and upload it again.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline">
            <a href="/api/inventory/template" download><Download className="h-4 w-4" /> Download template</a>
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Upload className="h-4 w-4" /> {fileName ? "Choose another file" : "Upload filled file"}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          </label>
          {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
        </div>
      </CardContent></Card>

      {error && <Alert tone="danger">{error}</Alert>}
      {pending && <p className="text-sm text-muted-foreground">Checking…</p>}

      {checked && (
        <Card><CardContent className="space-y-4 p-6">
          {problems.length ? (
            <Alert tone="warning">{problems.length} row{problems.length === 1 ? " has" : "s have"} problems. Fix them in the spreadsheet and upload it again - nothing is imported until every row is clean.</Alert>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">All {checked.rows.length} rows are fine. They will create <strong>{checked.items}</strong> inventory record{checked.items === 1 ? "" : "s"}.</p>
              <Button onClick={runImport} disabled={pending}>{pending ? "Importing…" : `Import ${checked.items} record${checked.items === 1 ? "" : "s"}`}</Button>
            </div>
          )}
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <THead><TR><TH>Row</TH><TH>Item</TH><TH>What happens</TH></TR></THead>
              <TBody>
                {(problems.length ? problems : checked.rows).map((r) => (
                  <TR key={r.row}>
                    <TD className="text-xs text-muted-foreground">{r.row}</TD>
                    <TD className="font-medium">{r.name}</TD>
                    <TD className="text-sm">
                      {r.errors.length
                        ? r.errors.map((e) => <div key={e} className="text-red-600">{e}</div>)
                        : <><Badge tone="success">OK</Badge> <span className="text-muted-foreground">{r.summary}</span></>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}
