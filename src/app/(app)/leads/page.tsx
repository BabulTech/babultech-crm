import Link from "next/link";
import { SavedViewsControl } from "@/components/saved-views";
import { applyDefaultView } from "@/server/saved-views";
import { Plus, Upload } from "lucide-react";
import { listLeads, getLeadFilterOptions, listCampaigns } from "@/server/crm";
import {
  PageHeader, Card, Table, THead, TBody, TR, TH, TD, Badge, statusTone,
  EmptyState, Input, Select, Button, StatTile, Forbidden
} from "@/components/ui";
import { formatMoney, humanize, serialize, formatMoneyTotal } from "@/lib/utils";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { ExportButton } from "@/components/export-button";
import { LeadsTable } from "./leads-table";
import { RECYCLE_TYPES } from "@/lib/recycle-types";
import { getAssignableUsers } from "@/server/bulk";
import { listPartnerOptions } from "@/server/partners";
import { countProspects } from "@/server/marketing";

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
  const [leads, users, campaigns, partners, prospects, prospecting] = await Promise.all([
    listLeads(params),
    getAssignableUsers(),
    listCampaigns(),
    listPartnerOptions(),
    countProspects(),
    getLeadFilterOptions(),
  ]);

  const open = leads.filter((l) => !["CONVERTED", "DISQUALIFIED"].includes(l.status));
  const partnerReferred = leads.filter((l) => l.referredByPartnerId).length;
  // Portal registrations nobody has looked at yet — the queue that matters.
  const awaitingReview = leads.filter(
    (l) => l.referredByPartnerId && l.status === "NEW",
  ).length;
  const pipelineValue = open.reduce((s, l) => s + Number(l.estimatedValue ?? 0), 0);

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
          value={String(prospects)}
          sublabel="Marketing's, not yet in the list"
          href="/leads?status=PROSPECT"
        />
        <StatTile label="Open leads" value={String(open.length)} />
        <StatTile label="Estimated value" value={formatMoneyTotal(pipelineValue)} tone="info" />
        <StatTile
          label="Partner registrations"
          value={String(partnerReferred)}
          sublabel={awaitingReview > 0 ? `${awaitingReview} awaiting review` : "Credited on conversion"}
          tone={awaitingReview > 0 ? "warning" : "neutral"}
          href="/leads?source=partner&status=NEW"
        />
        <StatTile
          label="Converted"
          value={String(leads.filter((l) => l.status === "CONVERTED").length)}
          tone="success"
        />
      </div>

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
