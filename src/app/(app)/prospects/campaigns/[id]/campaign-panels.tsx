"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABELS, CAMPAIGN_STATUS_TONE, type CampaignStatus } from "@/lib/prospect-outreach";
import { removeCampaignEntry, setCampaignStatus, setProspectCampaignMember, type CampaignEntryRow } from "@/server/prospect-campaigns";
import { CampaignForm, type CampaignValues, type MarketingCampaignOption } from "../campaign-form";

/** The campaign's prospects, with their status changeable in place. */
export function EntriesTable({ campaignId, rows, canWrite }: { campaignId: string; rows: CampaignEntryRow[]; canWrite: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    const r = await action();
    if (r.ok) window.location.reload();
    else setError(r.error ?? "Could not save.");
  });
  if (!rows.length) {
    return <p className="p-6 text-sm text-muted-foreground">No prospects here. Use Add prospects to bring some in from the Prospects list.</p>;
  }
  return (
    <>
      {error && <div className="p-4"><Alert tone="danger">{error}</Alert></div>}
      <Table>
        <THead>
          <TR>
            <TH>Business</TH>
            <TH>Phone</TH>
            <TH>Status</TH>
            <TH>Touches</TH>
            <TH priority="secondary">Last contacted</TH>
            {canWrite && <TH />}
          </TR>
        </THead>
        <TBody>
          {rows.map((e) => (
            <TR key={e.id}>
              <TD>
                <Link href={`/prospects/${e.prospectId}?campaign=${campaignId}`} className="font-medium hover:underline">{e.businessName}</Link>
                <p className="text-xs text-muted-foreground">{[e.icpTier, e.region, e.assignedTo && `Assigned: ${e.assignedTo}`].filter(Boolean).join(" · ")}</p>
              </TD>
              <TD className="whitespace-nowrap text-sm">
                {e.phone ? <a href={`tel:${e.phone.replace(/[^\d+]/g, "")}`} className="hover:underline">{e.phone}</a> : "—"}
              </TD>
              <TD>
                {canWrite ? (
                  <Select aria-label={`Status of ${e.businessName}`} value={e.status} disabled={pending} className="h-8 w-48"
                    onChange={(ev) => run(() => setCampaignStatus(campaignId, e.prospectId, ev.target.value as CampaignStatus))}>
                    {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{CAMPAIGN_STATUS_LABELS[s]}</option>)}
                  </Select>
                ) : (
                  <Badge tone={CAMPAIGN_STATUS_TONE[e.status]}>{CAMPAIGN_STATUS_LABELS[e.status]}</Badge>
                )}
              </TD>
              <TD className="tabular-nums">{e.touchCount}</TD>
              <TD priority="secondary" className="text-sm text-muted-foreground">{e.lastContactedAt ? formatDate(e.lastContactedAt) : "Never"}</TD>
              {canWrite && (
                <TD>
                  <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Take ${e.businessName} out of this campaign? Its logged outreach stays on the prospect.`)) run(() => removeCampaignEntry(e.id));
                    }}>
                    Remove
                  </Button>
                </TD>
              )}
            </TR>
          ))}
        </TBody>
      </Table>
    </>
  );
}

export function CampaignSettings({ values, marketingCampaigns }: { values: CampaignValues; marketingCampaigns: MarketingCampaignOption[] }) {
  const [open, setOpen] = useState(false);
  return open
    ? <CampaignForm values={values} onCancel={() => setOpen(false)} marketingCampaigns={marketingCampaigns} />
    : <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Edit campaign</Button>;
}

const ROLE_HELP: Record<string, string> = {
  manager: "Manager: works it and changes its settings and team",
  member: "Member: works it",
  viewer: "Viewer: sees it only",
};

/** Who works the campaign. No team means everyone with Prospecting access can. */
export function CampaignTeam({ campaignId, members, workers, canManage }: {
  campaignId: string;
  members: { userId: string; role: string; user: { id: string; fullName: string } | null }[];
  workers: { id: string; fullName: string; jobTitle: string | null }[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<"manager" | "member" | "viewer">("member");
  const set = (userId: string, r: "manager" | "member" | "viewer" | null) => start(async () => {
    const result = await setProspectCampaignMember(campaignId, userId, r);
    if (result.ok) window.location.reload();
    else setError(result.error);
  });
  const onTeam = new Set(members.map((m) => m.userId));
  return (
    <Card>
      <CardHeader><CardTitle>Team</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {members.length === 0 ? (
          <p className="text-muted-foreground">No team: everyone with Prospecting access can work this campaign. Add people to limit it to them.</p>
        ) : members.map((m) => (
          <div key={m.userId} className="flex items-center gap-2">
            <span className="flex-1">{m.user?.fullName ?? "Someone"}</span>
            {canManage ? (
              <>
                <Select aria-label={`Role of ${m.user?.fullName}`} value={m.role} className="h-8 w-32" disabled={pending}
                  onChange={(e) => set(m.userId, e.target.value as "manager" | "member" | "viewer")}>
                  <option value="manager">Manager</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </Select>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => set(m.userId, null)}>Remove</Button>
              </>
            ) : <Badge tone="neutral">{m.role}</Badge>}
          </div>
        ))}
        {canManage && (
          <div className="space-y-2 border-t pt-3">
            <Select aria-label="Add to team" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Add someone…</option>
              {workers.filter((w) => !onTeam.has(w.id)).map((w) => (
                <option key={w.id} value={w.id}>{w.fullName}{w.jobTitle ? ` · ${w.jobTitle}` : ""}</option>
              ))}
            </Select>
            <Select aria-label="Their role" value={role} onChange={(e) => setRole(e.target.value as "manager" | "member" | "viewer")}>
              {(["manager", "member", "viewer"] as const).map((r) => <option key={r} value={r}>{ROLE_HELP[r]}</option>)}
            </Select>
            <Button size="sm" disabled={pending || !who} onClick={() => set(who, role)}>Add to team</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
