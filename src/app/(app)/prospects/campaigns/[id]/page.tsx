import { notFound } from "next/navigation";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardContent, CardHeader, CardTitle, StatTile, Input, Select, Button, Forbidden, Badge } from "@/components/ui";
import { formatNumber, formatDate, humanize } from "@/lib/utils";
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABELS, CHANNEL_LABELS, type Channel } from "@/lib/prospect-outreach";
import { getProspectCampaign, listCampaignEntries, listProspectWorkers } from "@/server/prospect-campaigns";
import { CampaignSettings, CampaignTeam, EntriesTable } from "./campaign-panels";

type Params = { status?: string; search?: string; page?: string };

export default async function ProspectCampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const canWrite = can(me, PERMISSIONS.PROSPECT_WRITE);
  const { id } = await params;
  const q = await searchParams;
  const page = Math.max(0, Number(q.page ?? 0) || 0);
  const [campaign, entries, workers, next] = await Promise.all([
    getProspectCampaign(id),
    listCampaignEntries(id, { status: q.status, search: q.search }, page),
    canWrite ? listProspectWorkers() : Promise.resolve([]),
    listCampaignEntries(id, { status: "new" }, 0),
  ]);
  if (!campaign) notFound();

  // Plain links: a client-side change of only the query string did not take
  // effect on the production build.
  const link = (changes: Record<string, string | null>) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    return `/prospects/campaigns/${id}?${p.toString()}`;
  };
  const by = campaign.stats.byStatus;
  const firstNew = next.rows[0];

  return (
    <>
      <PageHeader
        backTo="/prospects/campaigns"
        backLabel="Outreach campaigns"
        title={campaign.name}
        description={[
          campaign.defaultChannel ? `Channel: ${CHANNEL_LABELS[campaign.defaultChannel as Channel]}` : "Any channel",
          `Follow up after ${campaign.followupDays} working days`,
          campaign.owner && `Owner: ${campaign.owner.fullName}`,
        ].filter(Boolean).join(" · ")}
      >
        <Badge tone={campaign.status === "ACTIVE" ? "success" : "neutral"}>{humanize(campaign.status)}</Badge>
        {canWrite && firstNew && (
          <Button asChild><a href={`/prospects/${firstNew.prospectId}?campaign=${id}`}>Start calling: {firstNew.businessName}</a></Button>
        )}
        {canWrite && <Button asChild variant="outline"><a href={`/prospects?addTo=${id}`}>Add prospects</a></Button>}
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        <a href={link({ status: null, page: null })}><StatTile label="All" value={formatNumber(campaign.stats.total, 0)} tone={!q.status ? "info" : "neutral"} /></a>
        {CAMPAIGN_STATUSES.map((s) => (
          <a key={s} href={link({ status: s, page: null })}>
            <StatTile label={CAMPAIGN_STATUS_LABELS[s]} value={formatNumber(by[s] ?? 0, 0)} tone={q.status === s ? "info" : "neutral"} />
          </a>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <form className="flex flex-wrap items-end gap-3 border-b p-4">
            <div className="min-w-[220px] flex-1"><Input name="search" placeholder="Search business…" defaultValue={q.search} /></div>
            <Select name="status" defaultValue={q.status ?? ""} className="w-56" aria-label="Status">
              <option value="">All statuses</option>
              {CAMPAIGN_STATUSES.map((s) => <option key={s} value={s}>{CAMPAIGN_STATUS_LABELS[s]}</option>)}
            </Select>
            <Button type="submit" variant="secondary">Filter</Button>
          </form>
          <EntriesTable campaignId={id} rows={entries.rows} canWrite={canWrite} />
          <div className="flex items-center justify-between border-t p-4 text-sm text-muted-foreground">
            <span>{entries.total ? `${formatNumber(page * 50 + 1, 0)}–${formatNumber(Math.min(entries.total, (page + 1) * 50), 0)} of ${formatNumber(entries.total, 0)}` : "No prospects here."}</span>
            <span className="flex gap-2">
              {page > 0 && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page - 1) })}>Previous</a></Button>}
              {(page + 1) * 50 < entries.total && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page + 1) })}>Next</a></Button>}
            </span>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>About</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {campaign.description && <p className="whitespace-pre-wrap">{campaign.description}</p>}
              <p className="text-muted-foreground">
                {campaign.startDate ? `From ${formatDate(campaign.startDate)}` : "No start date"}
                {campaign.endDate ? ` to ${formatDate(campaign.endDate)}` : ""}
              </p>
              {campaign.canManage && canWrite && (
                <CampaignSettings values={{
                  id, name: campaign.name, description: campaign.description, status: campaign.status, defaultChannel: campaign.defaultChannel,
                  followupDays: campaign.followupDays, startDate: campaign.startDate, endDate: campaign.endDate,
                }} />
              )}
            </CardContent>
          </Card>
          <CampaignTeam campaignId={id} members={campaign.members} workers={workers} canManage={campaign.canManage && canWrite} />
        </div>
      </div>
    </>
  );
}
