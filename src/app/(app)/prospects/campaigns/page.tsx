import Link from "next/link";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, Table, THead, TBody, TR, TH, TD, Badge, Forbidden, EmptyState } from "@/components/ui";
import { formatNumber, humanize } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/prospect-outreach";
import { listProspectCampaigns } from "@/server/prospect-campaigns";
import { NewCampaign } from "./campaign-form";

export default async function ProspectCampaignsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const canWrite = can(me, PERMISSIONS.PROSPECT_WRITE);
  const campaigns = await listProspectCampaigns();

  return (
    <>
      <PageHeader title="Outreach campaigns" description="Groups of prospects your team calls and emails, each with its own progress." backTo="/prospects" backLabel="Prospects">
        {canWrite && <NewCampaign />}
      </PageHeader>
      <Card>
        {campaigns.length === 0 ? (
          <EmptyState title="No outreach campaigns yet" description="Create one, then add prospects to it from the Prospects list." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Campaign</TH>
                <TH>Prospects</TH>
                <TH>Worked</TH>
                <TH>Replied / meeting</TH>
                <TH priority="secondary">Channel</TH>
                <TH priority="secondary">Team</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {campaigns.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link href={`/prospects/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    {c.owner && <p className="text-xs text-muted-foreground">Owner: {c.owner}</p>}
                  </TD>
                  <TD className="tabular-nums">{formatNumber(c.total, 0)}</TD>
                  <TD className="tabular-nums">{formatNumber(c.touched, 0)}{c.total ? <span className="ml-1 text-xs text-muted-foreground">({formatNumber((c.touched / c.total) * 100, 0)}%)</span> : null}</TD>
                  <TD className="tabular-nums">{formatNumber((c.byStatus.replied ?? 0) + (c.byStatus.interested_meeting ?? 0) + (c.byStatus.won ?? 0), 0)}</TD>
                  <TD priority="secondary" className="text-sm">{c.defaultChannel ? CHANNEL_LABELS[c.defaultChannel as Channel] : "Any"}</TD>
                  <TD priority="secondary" className="text-sm">{c.teamSize ? `${c.teamSize} people` : "Everyone"}</TD>
                  <TD><Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{humanize(c.status)}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
