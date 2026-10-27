import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardContent, CardHeader, CardTitle, DetailRow, Badge, Forbidden, Alert } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import { PROSPECT_STATUS_LABELS } from "@/lib/prospects";
import { getProspect, listDatasets } from "@/server/prospects";
import { ContactPoints, PeoplePanel, ProspectEditor, TagEditor } from "./prospect-panels";

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const canWrite = can(me, PERMISSIONS.PROSPECT_WRITE);
  const { id } = await params;
  const [p, datasets] = await Promise.all([getProspect(id), canWrite ? listDatasets() : Promise.resolve([])]);
  if (!p) notFound();

  const custom = Object.entries((p.customFields ?? {}) as Record<string, string>).filter(([, v]) => v);
  const website = p.website ? (/^https?:\/\//.test(p.website) ? p.website : `https://${p.website}`) : null;

  return (
    <>
      <PageHeader
        backTo="/prospects"
        backLabel="Prospects"
        title={p.businessName}
        description={[p.industry, p.dataset?.name].filter(Boolean).join(" · ") || undefined}
      >
        <Badge tone={p.status === "QUALIFIED" ? "success" : p.status === "ARCHIVED" ? "neutral" : "info"}>{PROSPECT_STATUS_LABELS[p.status] ?? p.status}</Badge>
      </PageHeader>

      {p.status === "QUALIFIED" && p.qualifiedLead && (
        <Alert tone="success">
          Qualified {p.qualifiedAt ? formatDateTime(p.qualifiedAt) : ""} and handed to sales as{" "}
          <Link href={`/leads/${p.qualifiedLead.id}`} className="font-medium underline">{p.qualifiedLead.leadNumber}</Link>.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ContactPoints prospectId={p.id} phones={p.phones} emails={p.emails} canWrite={canWrite} />
          <PeoplePanel prospectId={p.id} people={p.people as never} canWrite={canWrite} />
          {custom.length > 0 && (
            <Card>
              <CardHeader><CardTitle>More from the source sheet</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
                {custom.map(([k, v]) => (
                  <DetailRow key={k} label={k}>
                    {/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{v}</a> : <span className="whitespace-pre-wrap">{v}</span>}
                  </DetailRow>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Business</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Website">{website ? <a href={website} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{p.website}</a> : "—"}</DetailRow>
              <DetailRow label="Industry">{p.industry ?? "—"}</DetailRow>
              <DetailRow label="Address">{[p.street, p.city, p.region, p.country].filter(Boolean).join(", ") || "—"}</DetailRow>
              <DetailRow label="ICP tier">{p.icpTier ?? "—"}</DetailRow>
              <DetailRow label="Google">
                {p.googleRating != null ? `${Number(p.googleRating).toFixed(1)} ★${p.googleReviewCount != null ? ` from ${p.googleReviewCount} reviews` : ""}` : "—"}
                {p.googleMapsUrl && <> · <a href={p.googleMapsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Open listing</a></>}
              </DetailRow>
              <DetailRow label="Dataset">{p.dataset?.name ?? "—"}</DetailRow>
              <DetailRow label="Source">{p.source ?? "—"}</DetailRow>
              <DetailRow label="Added">{formatDateTime(p.createdAt)}</DetailRow>
            </CardContent>
          </Card>
          <TagEditor prospectId={p.id} tags={p.tags ?? []} canWrite={canWrite} />
          {canWrite && <ProspectEditor prospect={p as never} datasets={datasets.map((d) => ({ id: d.id, name: d.name }))} />}
        </div>
      </div>
    </>
  );
}
