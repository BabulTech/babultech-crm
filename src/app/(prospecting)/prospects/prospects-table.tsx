"use client";
import { softReload } from "@/components/soft-navigation";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert, Badge, Button, Input, Select, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { setProspectOwners, tagProspects, type ProspectFilters, type ProspectRow } from "@/server/prospects";
import { addFilteredProspectsToCampaign, addProspectsToCampaign } from "@/server/prospect-campaigns";

/** The page of prospects, with selection for tagging several at once. */
export function ProspectsTable({ rows, canWrite, campaigns, defaultCampaign, filters, matching, isPartner = false, partners = [], owners = [] }: {
  rows: ProspectRow[];
  canWrite: boolean;
  campaigns: { id: string; name: string }[];
  defaultCampaign: string;
  filters: ProspectFilters;
  matching: number;
  /** A partner's login: no mass email, and no Partner column. */
  isPartner?: boolean;
  /** Staff: the partner list, for the Partner column only. Handing prospects to a partner is on the partner's page. */
  partners?: { id: string; name: string }[];
  /** A partner's portal admin: their own logins, to hand prospects to. */
  owners?: { id: string; fullName: string }[];
}) {
  const [campaign, setCampaign] = useState(defaultCampaign);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState("");
  const [owner, setOwner] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function applyTag() {
    start(async () => {
      const result = await tagProspects([...selected], [tag]);
      if (!result.ok) { setMessage({ tone: "danger", text: result.error }); return; }
      softReload();
    });
  }

  function giveToPerson() {
    if (!owner) return;
    start(async () => {
      const result = await setProspectOwners([...selected], owner);
      if (!result.ok) { setMessage({ tone: "danger", text: result.error }); return; }
      setSelected(new Set());
      setMessage({ tone: "success", text: `Handed over ${result.data.changed}.` });
      softReload();
    });
  }

  function addToCampaign(all: boolean) {
    const name = campaigns.find((c) => c.id === campaign)?.name ?? "the campaign";
    if (all && !window.confirm(`Add all ${matching.toLocaleString()} prospects matching these filters to ${name}? Ones already in it keep their progress.`)) return;
    start(async () => {
      const result = all ? await addFilteredProspectsToCampaign(campaign, filters) : await addProspectsToCampaign(campaign, [...selected]);
      if (!result.ok) { setMessage({ tone: "danger", text: result.error }); return; }
      setSelected(new Set());
      setMessage({ tone: "success", text: `Added ${result.data.added.toLocaleString()} to ${name}${result.data.added === 0 ? " (they were all in it already)" : ""}.` });
    });
  }

  const campaignBar = canWrite && campaigns.length > 0 && (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
      <span className="text-muted-foreground">Add to campaign</span>
      <Select aria-label="Campaign to add to" value={campaign} onChange={(e) => setCampaign(e.target.value)} className="h-8 w-64">
        <option value="">Choose a campaign…</option>
        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Button size="sm" variant="outline" disabled={pending || !campaign || selected.size === 0} onClick={() => addToCampaign(false)}>
        Add {selected.size || ""} selected
      </Button>
      <Button size="sm" variant="outline" disabled={pending || !campaign || matching === 0} onClick={() => addToCampaign(true)}>
        Add all {matching.toLocaleString()} matching
      </Button>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
    </div>
  );
  const notice = message && !campaignBar && <div className="border-b px-4 py-2"><Alert tone={message.tone}>{message.text}</Alert></div>;

  if (!rows.length) {
    return <p className="p-6 text-sm text-muted-foreground">{isPartner ? "No prospects here yet. Import your own, or wait for us to give you some." : "No prospects here yet. Import a dataset to start."}</p>;
  }

  return (
    <>
      {campaignBar}
      {notice}
      {canWrite && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag, e.g. Call this week" className="h-8 w-56" aria-label="Tag to add" />
          <Button size="sm" onClick={applyTag} disabled={pending || !tag.trim()}>{pending ? "Tagging…" : "Add tag"}</Button>
          {!isPartner && <Button asChild size="sm" variant="outline"><a href={`/email/compose?type=Prospect&ids=${[...selected].join(",")}`}>Email {selected.size} selected</a></Button>}
          {owners.length > 0 && (
            <>
              <Select aria-label="Give to" value={owner} onChange={(e) => setOwner(e.target.value)} className="h-8 w-48">
                <option value="">Choose a person…</option>
                {owners.map((o) => <option key={o.id} value={o.id}>{o.fullName}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={pending || !owner} onClick={giveToPerson}>Give to</Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      <Table>
        <THead>
          <TR>
            {canWrite && (
              <TH className="w-8">
                <input type="checkbox" aria-label="Select all on this page" checked={all}
                  onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} />
              </TH>
            )}
            <TH>Business</TH>
            <TH>Phone</TH>
            <TH priority="secondary">Email</TH>
            {partners.length > 0 && <TH>Partner</TH>}
            <TH priority="secondary">Owner</TH>
            <TH priority="secondary">ICP tier</TH>
            <TH priority="tertiary">Region</TH>
            <TH priority="tertiary">Google</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              {canWrite && (
                <TD>
                  <input type="checkbox" aria-label={`Select ${r.businessName}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </TD>
              )}
              <TD>
                <Link href={`/prospects/${r.id}`} className="font-medium hover:underline">{r.businessName}</Link>
                <p className="text-xs text-muted-foreground">
                  {[r.industry, r.dataset].filter(Boolean).join(" · ")}
                </p>
                {r.tags.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.tags.slice(0, 3).map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                  </span>
                )}
              </TD>
              <TD className="whitespace-nowrap text-sm">
                {r.phone ?? "—"}
                {r.phoneCount > 1 && <span className="ml-1 text-xs text-muted-foreground">+{r.phoneCount - 1}</span>}
              </TD>
              <TD priority="secondary" className="text-sm">
                {r.email ?? "—"}
                {r.emailCount > 1 && <span className="ml-1 text-xs text-muted-foreground">+{r.emailCount - 1}</span>}
              </TD>
              {partners.length > 0 && <TD className="text-sm">{r.partner ?? "—"}</TD>}
              <TD priority="secondary" className="text-sm">{r.owner ?? "—"}</TD>
              <TD priority="secondary" className="text-sm">{r.icpTier ?? "—"}</TD>
              <TD priority="tertiary" className="text-sm">{r.region ?? "—"}</TD>
              <TD priority="tertiary" className="whitespace-nowrap text-sm">
                {r.googleRating != null ? `${r.googleRating.toFixed(1)} ★` : "—"}
                {r.googleReviewCount != null && <span className="ml-1 text-xs text-muted-foreground">({r.googleReviewCount})</span>}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </>
  );
}
