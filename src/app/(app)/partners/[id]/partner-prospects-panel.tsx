"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select, StatTile, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { softReload } from "@/components/soft-navigation";
import { assignProspectsToPartner, findProspectsToGive, type PartnerProspectRow } from "@/server/prospects";
import { PROSPECT_STATUS_LABELS } from "@/lib/prospects";

/**
 * A partner's prospects, on the partner's page: what they hold, giving them
 * more, and taking some back. Super Admin and CRM Admin only.
 */
export function PartnerProspectsPanel({ partnerId, partnerName, active, summary, options }: {
  partnerId: string;
  partnerName: string;
  /** Only an active partnership can be given prospects. */
  active: boolean;
  summary: { total: number; active: number; qualified: number; rows: PartnerProspectRow[] };
  options: { datasets: { id: string; name: string }[]; regions: string[] };
}) {
  const [giving, setGiving] = useState(false);
  const [found, setFound] = useState<PartnerProspectRow[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; };

  function search(fd: FormData) {
    start(async () => {
      setFound(await findProspectsToGive({ search: String(fd.get("search") ?? ""), datasetId: String(fd.get("datasetId") ?? ""), region: String(fd.get("region") ?? "") }));
      setPick(new Set());
    });
  }

  function give() {
    if (!pick.size || !window.confirm(`Give ${pick.size} prospect${pick.size === 1 ? "" : "s"} to ${partnerName}? Their portal admin decides who works each one.`)) return;
    start(async () => {
      const result = await assignProspectsToPartner([...pick], partnerId);
      if (!result.ok) { setMessage({ tone: "danger", text: result.error }); return; }
      setMessage({ tone: "success", text: `Gave ${result.data.changed} to ${partnerName}.` });
      setGiving(false); setFound(null); setPick(new Set());
      softReload();
    });
  }

  function takeBack() {
    if (!held.size || !window.confirm(`Take ${held.size} prospect${held.size === 1 ? "" : "s"} back from ${partnerName}? They lose access to them and to everything they logged on them.`)) return;
    start(async () => {
      const result = await assignProspectsToPartner([...held], null, partnerId);
      if (!result.ok) { setMessage({ tone: "danger", text: result.error }); return; }
      setMessage({ tone: "success", text: `Took back ${result.data.changed}.` });
      setHeld(new Set());
      softReload();
    });
  }

  return (
    <Card className="mt-6" data-testid="partner-prospects">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          Prospects
          <span className="flex gap-2">
            {held.size > 0 && <Button size="sm" variant="outline" disabled={pending} onClick={takeBack}>Take back {held.size}</Button>}
            {!giving && <Button size="sm" disabled={!active} onClick={() => setGiving(true)}>Give prospects</Button>}
          </span>
        </CardTitle>
        {!active && <p className="text-sm text-muted-foreground">Only an active partnership can be given prospects.</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="With them" value={String(summary.total)} />
          <StatTile label="Being worked" value={String(summary.active)} />
          <StatTile label="Qualified" value={String(summary.qualified)} tone={summary.qualified ? "success" : "neutral"} />
        </div>

        {giving && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm text-muted-foreground">Find prospects no partner holds yet, tick the ones to give, then confirm.</p>
            <form action={search} className="flex flex-wrap items-end gap-2">
              <Input name="search" placeholder="Business name…" className="h-9 w-56" aria-label="Business name" />
              <Select name="datasetId" defaultValue="" className="h-9 w-48" aria-label="Dataset">
                <option value="">All datasets</option>
                {options.datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
              {options.regions.length > 0 && (
                <Select name="region" defaultValue="" className="h-9 w-44" aria-label="Region">
                  <option value="">All regions</option>
                  {options.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              )}
              <Button type="submit" size="sm" variant="secondary" disabled={pending}>{pending ? "Searching…" : "Search"}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setGiving(false); setFound(null); setPick(new Set()); }}>Cancel</Button>
            </form>
            {found && (found.length === 0 ? <p className="text-sm text-muted-foreground">Nothing matches that is free to give.</p> : (
              <>
                <Table>
                  <THead><TR>
                    <TH className="w-8"><input type="checkbox" aria-label="Select all found" checked={found.every((r) => pick.has(r.id))}
                      onChange={() => setPick(found.every((r) => pick.has(r.id)) ? new Set() : new Set(found.map((r) => r.id)))} /></TH>
                    <TH>Business</TH><TH>Region</TH><TH>Dataset</TH>
                  </TR></THead>
                  <TBody>
                    {found.map((r) => (
                      <TR key={r.id}>
                        <TD><input type="checkbox" aria-label={`Give ${r.businessName}`} checked={pick.has(r.id)} onChange={() => setPick(toggle(pick, r.id))} /></TD>
                        <TD className="text-sm">{r.businessName}</TD>
                        <TD className="text-sm">{r.region ?? "—"}</TD>
                        <TD className="text-sm">{r.dataset ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {found.length === 100 && <p className="text-xs text-muted-foreground">Showing the first 100. Narrow the search to find others.</p>}
                <Button size="sm" disabled={pending || pick.size === 0} onClick={give}>Give {pick.size || ""} to {partnerName}</Button>
              </>
            ))}
          </div>
        )}

        {summary.rows.length === 0 ? <p className="text-sm text-muted-foreground">No prospects given yet.</p> : (
          <Table>
            <THead><TR><TH className="w-8" /><TH>Business</TH><TH>Their owner</TH><TH>Status</TH></TR></THead>
            <TBody>
              {summary.rows.map((r) => (
                <TR key={r.id}>
                  <TD><input type="checkbox" aria-label={`Take back ${r.businessName}`} checked={held.has(r.id)} onChange={() => setHeld(toggle(held, r.id))} /></TD>
                  <TD><Link href={`/prospects/${r.id}`} className="text-sm font-medium hover:underline">{r.businessName}</Link></TD>
                  <TD className="text-sm">{r.owner ?? "Not handed out yet"}</TD>
                  <TD><Badge tone={r.status === "QUALIFIED" ? "success" : "neutral"}>{PROSPECT_STATUS_LABELS[r.status] ?? r.status}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {summary.total > summary.rows.length && <p className="text-xs text-muted-foreground">Showing the latest {summary.rows.length} of {summary.total}. Filter by this partner on Prospects to see all.</p>}
      </CardContent>
    </Card>
  );
}
