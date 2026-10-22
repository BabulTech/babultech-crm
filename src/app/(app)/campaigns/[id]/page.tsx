import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { DeleteControl } from "@/components/delete-control";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Button, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, DetailRow, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, humanize, formatMoneyTotal } from "@/lib/utils";
import { getCampaignEmailStats } from "@/server/activities";
import { Megaphone, Plus } from "lucide-react";
import { CampaignFunnel, CampaignTouches } from "@/components/campaign-funnel";
import { WebFormsCard } from "@/components/web-forms-card";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.LEAD_READ)) return <Forbidden what="campaigns" />;
  const db = await supabaseServer();
  // Grouped through the LEADS rather than off a send, because one email may go
  // to leads from several campaigns and each lead already records the campaign
  // that produced it. This gives this campaign only its own share.
  //
  // All three reads take only the id, so they run together. PostgREST cannot
  // embed the reverse side of a self-referencing FK, so the child campaigns are
  // their own query.
  const [emailStats, { data: campaignRow }, { data: childCampaigns }] = await Promise.all([
    getCampaignEmailStats(id),
    db
    .from("campaign")
    .select(
      `*,
       campaignType:campaign_type ( * ),
       owner:app_user!campaign_ownerUserId_fkey ( id, fullName ),
       parentCampaign:parentCampaignId ( id, name ),
       leads:lead!lead_campaignId_fkey ( id, leadNumber, firstName, lastName, companyName, status, estimatedValue, createdAt ),
       opportunities:opportunity ( id, opportunityNumber, name, stage, amount, currencyCode, expectedCloseDate, account ( id, name ) ),
       members:campaign_member!campaign_member_campaignId_fkey ( count )`,
    )
    .eq("id", id)
    .maybeSingle(),
    db.from("campaign").select("id, name, status").eq("parentCampaignId", id),
  ]);

  type Row = Record<string, unknown>;
  const desc = (a: unknown, b: unknown) => String(b ?? "").localeCompare(String(a ?? ""));

  const campaign = campaignRow
    ? {
        ...campaignRow,
        campaignType: one(campaignRow.campaignType as never),
        owner: one(campaignRow.owner as never),
        parentCampaign: one(campaignRow.parentCampaign as never),
        childCampaigns: childCampaigns ?? [],
        leads: ((campaignRow.leads ?? []) as Row[])
          .sort((a, b) => desc(a.createdAt, b.createdAt))
          .slice(0, 50),
        opportunities: ((campaignRow.opportunities ?? []) as Row[])
          .map((o): Row => ({ ...o, account: one(o.account as never) }))
          .sort((a, b) => desc(a.expectedCloseDate, b.expectedCloseDate))
          .slice(0, 50),
        _count: {
          members:
            (campaignRow.members as { count: number }[] | undefined)?.[0]?.count ?? 0,
        },
      }
    : null;

  if (!campaign) notFound();

  const spend = Number(campaign.actualCost ?? 0);
  const converted = campaign.leads.filter((l: Record<string, any>) => l.status === "CONVERTED").length;
  const won = campaign.opportunities.filter((o: Record<string, any>) => o.stage === "CLOSED_WON");
  const wonValue = won.reduce((s: any, o: Record<string, any>) => s + Number(o.amount), 0);
  const pipeline = campaign.opportunities
    .filter((o: Record<string, any>) => !["CLOSED_WON", "CLOSED_LOST"].includes(o.stage))
    .reduce((s: any, o: Record<string, any>) => s + Number(o.amount), 0);
  const roi = spend > 0 ? ((wonValue - spend) / spend) * 100 : null;
  const costPerLead = campaign.leads.length > 0 && spend > 0 ? spend / campaign.leads.length : null;

  return (
    <>
      <PageHeader
        backTo="/campaigns"
        backLabel="Back to campaigns"
        title={campaign.name}
        description={`${campaign.campaignNumber} · ${campaign.campaignType?.name}`}
      >
        <Badge tone={statusTone(campaign.status)}>{humanize(campaign.status)}</Badge>
        {can(_me, PERMISSIONS.LEAD_WRITE) && (
          <Button asChild variant="outline">
            <Link href={`/campaigns/${campaign.id}/edit`}>Edit</Link>
          </Button>
        )}
        <CorrectControl type="Campaign" id={id} />
        <FavoriteControl entityType="Campaign" entityId={id} label={String(campaign.name ?? "")} />
        <RecentMark entityType="Campaign" entityId={id} label={String(campaign.name ?? "")} />
        <DeleteControl type="Campaign" id={id} name={String(campaign.name ?? "")} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Spend"
          value={formatMoneyTotal(campaign.actualCost)}
          sublabel={campaign.budgetAmount ? `of ${formatMoney(campaign.budgetAmount)} budget` : "No budget set"}
          tone={campaign.budgetAmount && spend > Number(campaign.budgetAmount) ? "danger" : "neutral"}
        />
        <StatTile
          label="Leads"
          value={String(campaign.leads.length)}
          sublabel={`${converted} converted${costPerLead ? ` · ${formatMoney(costPerLead)}/lead` : ""}`}
        />
        <StatTile label="Open pipeline" value={formatMoneyTotal(pipeline)} sublabel={`${campaign.opportunities.length} deal(s)`} tone="info" />
        <StatTile
          label="ROI"
          value={roi === null ? "—" : formatPercent(roi, 0)}
          sublabel={`${formatMoney(wonValue)} won`}
          tone={roi === null ? "neutral" : roi >= 0 ? "success" : "danger"}
        />
      </div>

      <CampaignFunnel campaignId={id} />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Leads generated</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {campaign.leads.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">No leads attributed to this campaign.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Lead</TH>
                      <TH priority="secondary">Company</TH>
                      <TH className="text-right">Est. value</TH>
                      <TH priority="secondary">Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {campaign.leads.map((l: Record<string, any>) => (
                      <TR key={l.id}>
                        <TD>
                          {/* Goes to the lead, not straight into its edit form,
                              and carries `campaign` so a touch logged from
                              there is attributed here by default. */}
                          <Link
                            href={`/leads/${l.id}?campaign=${campaign.id}`}
                            className="font-medium hover:underline"
                          >
                            {l.firstName} {l.lastName}
                          </Link>
                          <p className="text-xs text-muted-foreground">{l.leadNumber}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                            <Badge tone={statusTone(l.status)}>{humanize(l.status)}</Badge>
                            {l.companyName && (
                              <span className="truncate text-xs text-muted-foreground">{l.companyName}</span>
                            )}
                          </div>
                        </TD>
                        <TD priority="secondary" className="text-sm">{l.companyName ?? "—"}</TD>
                        <TD className="whitespace-nowrap text-right tabular">{formatMoney(l.estimatedValue)}</TD>
                        <TD priority="secondary"><Badge tone={statusTone(l.status)}>{humanize(l.status)}</Badge></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Opportunities influenced</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {campaign.opportunities.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">No deals attributed yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Deal</TH>
                      <TH priority="tertiary">Customer</TH>
                      <TH className="text-right">Amount</TH>
                      <TH priority="secondary">Stage</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {campaign.opportunities.map((o: Record<string, any>) => (
                      <TR key={o.id}>
                        <TD>
                          <Link href={`/opportunities/${o.id}`} className="font-medium hover:underline">
                            {o.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">{o.opportunityNumber}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                            <Badge tone={statusTone(o.stage)}>{humanize(o.stage)}</Badge>
                            <span className="truncate text-xs text-muted-foreground">{o.account?.name}</span>
                          </div>
                        </TD>
                        <TD priority="tertiary" className="text-sm">
                          <Link href={`/accounts/${o.account?.id}`} className="hover:underline">
                            {o.account?.name}
                          </Link>
                        </TD>
                        <TD className="whitespace-nowrap text-right tabular">{formatMoney(o.amount, o.currencyCode)}</TD>
                        <TD priority="secondary"><Badge tone={statusTone(o.stage)}>{humanize(o.stage)}</Badge></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Type">{campaign.campaignType?.name}</DetailRow>
              <DetailRow label="Owner">{campaign.owner?.fullName}</DetailRow>
              <DetailRow label="Runs">
                {formatDate(campaign.startDate)} → {formatDate(campaign.endDate)}
              </DetailRow>
              <DetailRow label="Budget">{formatMoney(campaign.budgetAmount)}</DetailRow>
              <DetailRow label="Expected">
                {campaign.expectedLeads ?? "—"} leads · {formatMoney(campaign.expectedRevenue)}
              </DetailRow>
              <DetailRow label="Members">{campaign._count.members}</DetailRow>
              <DetailRow label="Parent campaign">
                {campaign.parentCampaign ? (
                  <Link href={`/campaigns/${campaign.parentCampaign.id}`} className="text-primary hover:underline">
                    {campaign.parentCampaign.name}
                  </Link>
                ) : "—"}
              </DetailRow>
              {campaign.childCampaigns.length > 0 && (
                <DetailRow label="Sub-campaigns">
                  <div className="space-y-0.5">
                    {campaign.childCampaigns.map((c: Record<string, any>) => (
                      <Link key={c.id} href={`/campaigns/${c.id}`} className="block text-primary hover:underline">
                        {c.name}
                      </Link>
                    ))}
                  </div>
                </DetailRow>
              )}
            </CardContent>
          </Card>

          {campaign.description && (
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{campaign.description}</p>
              </CardContent>
            </Card>
          )}

          {/*
            What the emails to this campaign's leads achieved.

            Campaign activities used to live here as their own records with their
            own audiences. Emails are now activities against a lead, so this is
            rolled up from them - and a lead carries the campaign that produced
            it, so the roll-up stays right however mixed a send was.
          */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <Megaphone className="h-4 w-4" /> Email to these leads
              </CardTitle>
              {can(_me, PERMISSIONS.LEAD_WRITE) && (
                <Button asChild size="sm" variant="secondary">
                  <Link href={`/leads?campaignId=${id}`}>
                    <Plus className="h-4 w-4" /> Email this campaign
                  </Link>
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {emailStats.audience === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No email has gone to a lead from this campaign yet. Open the leads list,
                  choose the people you want, and press Email.
                </p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <StatTile label="Emails sent" value={String(emailStats.sent)} />
                    <StatTile
                      label="Delivered"
                      value={String(emailStats.delivered)}
                      tone="success"
                    />
                    {/* Clicks before opens: a click is somebody deciding to act. */}
                    <StatTile label="Clicked" value={String(emailStats.clicked)} tone="info" />
                    <StatTile label="Opened" value={String(emailStats.opened)} />
                  </div>
                  {(emailStats.bounced > 0 || emailStats.unsubscribed > 0) && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {emailStats.bounced > 0 && `${emailStats.bounced} bounced. `}
                      {emailStats.unsubscribed > 0 &&
                        `${emailStats.unsubscribed} unsubscribed - suppressed everywhere, not only here.`}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CampaignTouches campaignId={id} />
        <WebFormsCard campaignId={id} canWrite={can(_me, PERMISSIONS.LEAD_WRITE)} />
      </div>
    </>
  );
}
