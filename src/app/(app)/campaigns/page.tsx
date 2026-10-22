import Link from "next/link";
import { SavedViewsControl } from "@/components/saved-views";
import { applyDefaultView } from "@/server/saved-views";
import { Plus } from "lucide-react";
import { listCampaigns, getCampaignPerformance } from "@/server/crm";
import { ListFilters, optionsFrom } from "@/components/list-filters";
import {
  PageHeader, Button, Card, CardHeader, CardTitle, CardContent, Table, THead, TBody,
  TR, TH, TD, Badge, statusTone, EmptyState, StatTile, Alert, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, humanize, formatMoneyTotal } from "@/lib/utils";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { RowActions } from "@/components/row-actions";
import { RECYCLE_TYPES } from "@/lib/recycle-types";
import { ExportButton } from "@/components/export-button";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; status?: string }>;
}) {
  const _me = await requireUser();
  const canDeleteRow = can(_me, RECYCLE_TYPES.Campaign.permission);
  if (!can(_me, PERMISSIONS.LEAD_READ)) return <Forbidden what="campaigns" />;

  const params = await searchParams;
  await applyDefaultView("campaigns", params);
  // ROI comes from the v_campaign_performance view (20261004000000). A failed
  // read leaves the campaign list working and says so above the table. Read
  // alongside the list rather than after it.
  let viewMissing = false;
  // eslint-disable-next-line prefer-const -- narrowed below
  let [campaigns, performance] = await Promise.all([
    listCampaigns(params),
    getCampaignPerformance().catch((): Awaited<ReturnType<typeof getCampaignPerformance>> => {
      viewMissing = true;
      return [];
    }),
  ]);

  // The view is read whole rather than filtered, so it has to be narrowed to
  // the same campaigns the list above is showing — otherwise a search hides
  // rows in one table and leaves them visible in the other.
  const visibleIds = new Set(campaigns.map((c) => c.id));
  performance = performance.filter((p) => visibleIds.has(p.campaign_id));

  const totalSpend = campaigns.reduce((s, c) => s + Number(c.actualCost ?? 0), 0);
  const totalBudget = campaigns.reduce((s, c) => s + Number(c.budgetAmount ?? 0), 0);
  const totalLeads = campaigns.reduce((s, c) => s + c._count.leads, 0);
  const wonValue = performance.reduce((s, p) => s + Number(p.won_value ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Marketing spend against leads generated, pipeline created and revenue won."
      >
        <Button asChild variant="outline"><Link href="/campaigns/dashboard">Marketing dashboard</Link></Button>
        <Button asChild variant="outline"><Link href="/campaigns/forms">Website forms</Link></Button>
        <Button asChild variant="outline"><Link href="/campaigns/scoring">Lead scoring</Link></Button>
        <ExportButton entity="campaigns" params={{ search: params.search, status: params.status }} />
        {can(_me, PERMISSIONS.LEAD_WRITE) && (
          <Button asChild>
            <Link href="/campaigns/new">
              <Plus className="h-4 w-4" /> New campaign
            </Link>
          </Button>
        )}
        <SavedViewsControl entity="campaigns" />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total budget" value={formatMoneyTotal(totalBudget)} sublabel={`${campaigns.length} campaigns`} />
        <StatTile label="Actual spend" value={formatMoneyTotal(totalSpend)} tone={totalSpend > totalBudget ? "danger" : "neutral"} />
        <StatTile label="Leads generated" value={String(totalLeads)} tone="info" />
        <StatTile label="Won revenue" value={formatMoneyTotal(wonValue)} tone="success" />
      </div>

      <div className="mt-6">
        <ListFilters
          searchPlaceholder="Search campaign name or number…"
          searchValue={params.search}
          selects={[
            {
              name: "status",
              allLabel: "All statuses",
              value: params.status,
              options: optionsFrom(["PLANNED", "ACTIVE", "PAUSED", "COMPLETED"]),
            },
          ]}
        />
      </div>

      {viewMissing && (
        <div className="mt-6">
          <Alert tone="warning">
            Return on investment could not be loaded just now, so the table below is missing. Reload the page; if it
            stays missing, tell your administrator.
          </Alert>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {campaigns.length === 0 ? (
            <div className="px-5">
              <EmptyState title="No campaigns yet" description="Create a campaign to attribute leads and revenue to your marketing." />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH priority="secondary">Type</TH>
                  <TH priority="tertiary">Owner</TH>
                  <TH priority="tertiary">Period</TH>
                  <TH className="text-right" priority="tertiary">Budget</TH>
                  <TH className="text-right" priority="secondary">Spend</TH>
                  <TH className="text-right" priority="tertiary">Leads</TH>
                  <TH className="text-right" priority="tertiary">Deals</TH>
                  <TH>Status</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <TBody>
                {campaigns.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{c.campaignNumber}</p>
                    </TD>
                    <TD priority="secondary" className="text-sm text-muted-foreground">
                      {c.campaignType?.name}
                      {c.campaignType?.channel && <p className="text-xs">{c.campaignType?.channel}</p>}
                    </TD>
                    <TD priority="tertiary" className="text-sm text-muted-foreground">{c.owner?.fullName}</TD>
                    <TD priority="tertiary" className="text-sm">
                      {formatDate(c.startDate)} → {formatDate(c.endDate)}
                    </TD>
                    <TD priority="tertiary" className="text-right tabular">{formatMoney(c.budgetAmount)}</TD>
                    <TD
                      priority="secondary"
                      className={`text-right tabular ${
                        Number(c.actualCost ?? 0) > Number(c.budgetAmount ?? 0)
                          ? "text-red-600 dark:text-red-400"
                          : ""
                      }`}
                    >
                      {formatMoney(c.actualCost)}
                    </TD>
                    <TD priority="tertiary" className="text-right tabular">{c._count.leads}</TD>
                    <TD priority="tertiary" className="text-right tabular">{c._count.opportunities}</TD>
                    <TD>
                      <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                    </TD>
                    <TD className="text-right">
                      <RowActions type="Campaign" id={c.id} name={String(c.name ?? "")} editHref={`/campaigns/${c.id}/edit`} canDelete={canDeleteRow} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {performance.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Return on investment</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH className="text-right" priority="secondary">Spend</TH>
                  <TH className="text-right" priority="tertiary">Leads</TH>
                  <TH className="text-right">Cost / lead</TH>
                  <TH className="text-right">Converted</TH>
                  <TH className="text-right">Pipeline</TH>
                  <TH className="text-right">Won</TH>
                  <TH className="text-right">ROI</TH>
                </TR>
              </THead>
              <TBody>
                {performance.map((p) => (
                  <TR key={p.campaign_id}>
                    <TD className="text-sm font-medium">
                      <Link href={`/campaigns/${p.campaign_id}`} className="hover:underline">
                        {p.campaign_name}
                      </Link>
                    </TD>
                    <TD priority="secondary" className="text-right tabular">{formatMoney(p.actual_cost)}</TD>
                    <TD priority="tertiary" className="text-right tabular">{Number(p.leads)}</TD>
                    <TD priority="tertiary" className="text-right tabular">
                      {p.cost_per_lead ? formatMoney(p.cost_per_lead) : "—"}
                    </TD>
                    <TD priority="tertiary" className="text-right tabular">{Number(p.converted_leads)}</TD>
                    <TD priority="secondary" className="text-right tabular">{formatMoney(p.pipeline_value)}</TD>
                    <TD priority="tertiary" className="text-right font-medium tabular">{formatMoney(p.won_value)}</TD>
                    <TD
                      className={`text-right tabular ${
                        p.roi_percent && Number(p.roi_percent) > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : p.roi_percent
                            ? "text-red-600 dark:text-red-400"
                            : ""
                      }`}
                    >
                      {p.roi_percent === null ? "—" : formatPercent(p.roi_percent, 0)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
