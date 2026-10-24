import Link from "next/link";
import { SavedViewsControl } from "@/components/saved-views";
import { applyDefaultView } from "@/server/saved-views";
import { Plus, Upload } from "lucide-react";
import { listLeads, getLeadFilterOptions, getLeadStats, listCampaigns } from "@/server/crm";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Table, THead, TBody, TR, TH, TD, Badge, statusTone,
  EmptyState, Input, Select, Button, StatTile, Forbidden
} from "@/components/ui";
import { formatMoney, humanize, serialize, formatMoneyTotal, formatNumber } from "@/lib/utils";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { ExportButton } from "@/components/export-button";
import { LeadsTable } from "./leads-table";
import { RECYCLE_TYPES } from "@/lib/recycle-types";
import { getAssignableUsers } from "@/server/bulk";
import { listPartnerOptions } from "@/server/partners";

const STATUSES = [
  "PROSPECT", "NEW", "ASSIGNED", "ATTEMPTED_CONTACT", "CONTACTED", "DISCOVERY_SCHEDULED",
  "QUALIFIED", "NURTURING", "DISQUALIFIED", "CONVERTED",
];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string; status?: string; source?: string; campaignId?: string; partnerId?: string;
    icpTier?: string; region?: string; leadList?: string;
  }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.LEAD_READ)) return <Forbidden what="leads" />;

  const params = await searchParams;
  await applyDefaultView("leads", params);
  const [leads, users, campaigns, partners, stats, prospecting] = await Promise.all([
    listLeads(params),
    getAssignableUsers(),
    listCampaigns(),
    listPartnerOptions(),
    getLeadStats(params),
    getLeadFilterOptions(),
  ]);

  // Counted in the database, not from the rows loaded below, which stop at 500.
  const awaitingReview = stats.awaitingReview;
  // A link to this page with one more filter set, for the breakdown rows.
  const withFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string" && v) as [string, string][]);
    if (value) next.set(key, value); else next.delete(key);
    return `/leads?${next.toString()}`;
  };
  const BREAKDOWNS = [
    { key: "status", title: "By status", label: (v: string) => humanize(v) },
    { key: "icpTier", title: "By ICP tier", label: (v: string) => v },
    { key: "region", title: "By region", label: (v: string) => v },
    { key: "leadList", title: "By lead list", label: (v: string) => v },
  ] as const;

  return (
    <>
      <PageHeader
        title="Leads"
        description="Unqualified prospects. Converting one creates the account, contact and deal - and carries any partner referral through."
      >
        <Button asChild variant="outline"><Link href="/leads/board">Board</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/duplicates">Duplicates</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/email/sends">Emails sent</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/calling">My calling queue</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/handoffs">Sales handoffs</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/research">Research quality</Link></Button>
        <Button asChild variant="outline"><Link href="/leads/referrals">Referrals</Link></Button>
        <ExportButton entity="leads" params={{ search: params.search, status: params.status, source: params.source, partnerId: params.partnerId }} />
        {can(_me, PERMISSIONS.LEAD_WRITE) && (
          <Button asChild variant="outline">
            <Link href="/leads/import">
              <Upload className="h-4 w-4" /> Import
            </Link>
          </Button>
        )}
        <Button asChild>
          <Link href="/leads/new">
            <Plus className="h-4 w-4" /> New lead
          </Link>
        </Button>
        <SavedViewsControl entity="leads" />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Prospects"
          value={formatNumber(stats.prospects, 0)}
          sublabel="Marketing's, not yet in the list"
          href="/leads?status=PROSPECT"
        />
        <StatTile label="Open leads" value={formatNumber(stats.open, 0)} sublabel={`of ${formatNumber(stats.total, 0)} in this view`} />
        <StatTile label="Estimated value" value={formatMoneyTotal(stats.estimatedValue)} tone="info" />
        <StatTile
          label="Partner registrations"
          value={formatNumber(stats.partnerRegistrations, 0)}
          sublabel={awaitingReview > 0 ? `${awaitingReview} awaiting review` : "Credited on conversion"}
          tone={awaitingReview > 0 ? "warning" : "neutral"}
          href="/leads?source=partner&status=NEW"
        />
        <StatTile
          label="Converted"
          value={formatNumber(stats.converted, 0)}
          sublabel={stats.total ? `${formatNumber((stats.converted / stats.total) * 100, 1)}% of this view` : undefined}
          tone="success"
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Breakdown</CardTitle>
          <p className="text-sm text-muted-foreground">Every lead in this view, counted. Click a row to filter the list to it.</p>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {BREAKDOWNS.map(({ key, title, label }) => {
            const items = (stats.breakdown[key] ?? []).filter((i) => i.value);
            if (!items.length) return null;
            const max = Math.max(...items.map((i) => i.count));
            return (
              <div key={key} className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
                {items.slice(0, 8).map((i) => (
                  <Link key={i.value} href={withFilter(key, i.value)} className="block rounded px-1 py-0.5 hover:bg-muted">
                    <span className="flex justify-between gap-2 text-sm">
                      <span className="truncate">{label(i.value!)}</span>
                      <span className="tabular-nums text-muted-foreground">{formatNumber(i.count, 0)}</span>
                    </span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, (i.count / max) * 100)}%` }} />
                    </span>
                  </Link>
                ))}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <form className="flex flex-wrap items-end gap-3 border-b p-4">
          <div className="min-w-[220px] flex-1">
            <Input name="search" placeholder="Search name, company, phone or number…" defaultValue={params.search} />
          </div>
          <Select name="source" defaultValue={params.source ?? ""} className="w-52">
            <option value="">All sources</option>
            <option value="partner">Partner registrations</option>
          </Select>
          {partners.length > 0 && (
            <Select name="partnerId" defaultValue={params.partnerId ?? ""} className="w-52" aria-label="Partner">
              <option value="">All partners</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </Select>
          )}
          <Select name="status" defaultValue={params.status ?? ""} className="w-52">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{humanize(s)}</option>
            ))}
          </Select>
          {/* How "email everyone this campaign brought us" is done: narrow to
              the campaign, tick all, press Email. */}
          <Select name="campaignId" defaultValue={params.campaignId ?? ""} className="w-52">
            <option value="">All campaigns</option>
            {campaigns.map((c: { id: string; name: string }) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          {prospecting.icpTiers.length > 0 && (
            <Select name="icpTier" defaultValue={params.icpTier ?? ""} className="w-52" aria-label="ICP tier">
              <option value="">All ICP tiers</option>
              {prospecting.icpTiers.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          {prospecting.regions.length > 0 && (
            <Select name="region" defaultValue={params.region ?? ""} className="w-52" aria-label="Region">
              <option value="">All regions</option>
              {prospecting.regions.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          {prospecting.leadLists.length > 0 && (
            <Select name="leadList" defaultValue={params.leadList ?? ""} className="w-52" aria-label="Lead list">
              <option value="">All lead lists</option>
              {prospecting.leadLists.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          <Button type="submit" variant="secondary">Filter</Button>
        </form>

        {stats.total > leads.length && (
          <p className="border-b bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
            Showing the newest {formatNumber(leads.length, 0)} of {formatNumber(stats.total, 0)} leads. Narrow it with the filters or search above; the figures above count all of them.
          </p>
        )}
        <LeadsTable
          leads={serialize(leads) as never}
          users={users}
          canWrite={can(_me, PERMISSIONS.LEAD_WRITE)}
          canDelete={can(_me, RECYCLE_TYPES.Lead.permission)}
        />
      </Card>
    </>
  );
}
