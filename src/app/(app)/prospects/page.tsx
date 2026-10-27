import Link from "next/link";
import { Upload } from "lucide-react";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardContent, CardHeader, CardTitle, StatTile, Input, Select, Button, Forbidden } from "@/components/ui";
import { formatNumber } from "@/lib/utils";
import { PROSPECT_PAGE_SIZE, PROSPECT_STATUSES, PROSPECT_STATUS_LABELS } from "@/lib/prospects";
import { getProspectFilterValues, getProspectStats, listDatasets, listProspects } from "@/server/prospects";
import { ProspectsTable } from "./prospects-table";

type Params = { search?: string; datasetId?: string; status?: string; icpTier?: string; region?: string; tag?: string; page?: string };

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireUser();
  const canRead = can(me, PERMISSIONS.PROSPECT_READ) || can(me, PERMISSIONS.PROSPECT_WRITE);
  if (!canRead) return <Forbidden what="prospects" />;
  const canWrite = can(me, PERMISSIONS.PROSPECT_WRITE);

  const params = await searchParams;
  const page = Math.max(0, Number(params.page ?? 0) || 0);
  const [rows, stats, values, datasets] = await Promise.all([
    listProspects(params, page),
    getProspectStats(params),
    getProspectFilterValues(),
    listDatasets(),
  ]);

  const pages = Math.max(1, Math.ceil(stats.total / PROSPECT_PAGE_SIZE));
  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    return `/prospects?${next.toString()}`;
  };
  const pct = (n: number) => (stats.total ? `${formatNumber((n / stats.total) * 100, 0)}% of these` : undefined);

  return (
    <>
      <PageHeader
        title="Prospects"
        description="Businesses marketing is working through. The ones you qualify become sales leads; everything before that stays here."
      >
        <Button asChild variant="outline"><Link href="/prospects/datasets">Datasets</Link></Button>
        {canWrite && (
          <Button asChild>
            <Link href="/prospects/import"><Upload className="h-4 w-4" /> Import</Link>
          </Button>
        )}
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Prospects" value={formatNumber(stats.total, 0)} sublabel="Matching the filters below" />
        <StatTile label="With a phone" value={formatNumber(stats.withPhone, 0)} sublabel={pct(stats.withPhone)} />
        <StatTile label="With an email" value={formatNumber(stats.withEmail, 0)} sublabel={pct(stats.withEmail)} />
        <StatTile label="With a website" value={formatNumber(stats.withWebsite, 0)} sublabel={pct(stats.withWebsite)} />
        <StatTile label="Qualified to leads" value={formatNumber(stats.qualified, 0)} tone="success" />
      </div>

      {(stats.byIcpTier.length > 0 || stats.byRegion.length > 0) && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Breakdown</CardTitle></CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            {([["ICP tier", "icpTier", stats.byIcpTier], ["Region", "region", stats.byRegion]] as const).map(([title, key, items]) =>
              items.length ? (
                <div key={key} className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By {title.toLowerCase()}</p>
                  {items.slice(0, 8).map((i) => (
                    <a key={i.value} href={link({ [key]: i.value, page: null })} className="block rounded px-1 py-0.5 hover:bg-muted">
                      <span className="flex justify-between gap-2 text-sm">
                        <span className="truncate">{i.value}</span>
                        <span className="tabular-nums text-muted-foreground">{formatNumber(i.count, 0)}</span>
                      </span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, (i.count / items[0].count) * 100)}%` }} />
                      </span>
                    </a>
                  ))}
                </div>
              ) : null,
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <form className="flex flex-wrap items-end gap-3 border-b p-4">
          <div className="min-w-[240px] flex-1">
            <Input name="search" placeholder="Search business, phone, email or website…" defaultValue={params.search} />
          </div>
          <Select name="datasetId" defaultValue={params.datasetId ?? ""} className="w-52" aria-label="Dataset">
            <option value="">All datasets</option>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select name="status" defaultValue={params.status ?? ""} className="w-52" aria-label="Status">
            <option value="">Being worked</option>
            {PROSPECT_STATUSES.filter((s) => s !== "ACTIVE").map((s) => <option key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</option>)}
          </Select>
          {values.icpTiers.length > 0 && (
            <Select name="icpTier" defaultValue={params.icpTier ?? ""} className="w-52" aria-label="ICP tier">
              <option value="">All ICP tiers</option>
              {values.icpTiers.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          {values.regions.length > 0 && (
            <Select name="region" defaultValue={params.region ?? ""} className="w-52" aria-label="Region">
              <option value="">All regions</option>
              {values.regions.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          {values.tags.length > 0 && (
            <Select name="tag" defaultValue={params.tag ?? ""} className="w-52" aria-label="Tag">
              <option value="">All tags</option>
              {values.tags.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          <Button type="submit" variant="secondary">Filter</Button>
        </form>

        <ProspectsTable rows={rows} canWrite={canWrite} />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm text-muted-foreground">
          <span>
            {stats.total === 0
              ? "No prospects match."
              : `${formatNumber(page * PROSPECT_PAGE_SIZE + 1, 0)}–${formatNumber(Math.min(stats.total, (page + 1) * PROSPECT_PAGE_SIZE), 0)} of ${formatNumber(stats.total, 0)}`}
          </span>
          <span className="flex gap-2">
            {/* Plain links: a client-side change of only the query string did not
                take effect on the production build (as with the date filter). */}
            {page > 0 && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page - 1) })}>Previous</a></Button>}
            {page + 1 < pages && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page + 1) })}>Next</a></Button>}
          </span>
        </div>
      </Card>
    </>
  );
}
