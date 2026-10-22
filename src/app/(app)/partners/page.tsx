import Link from "next/link";
import { toDecimal } from "@/lib/decimal";
import { Building2, User } from "lucide-react";
import { listPartners } from "@/server/partners";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { RowActions } from "@/components/row-actions";
import { RECYCLE_TYPES } from "@/lib/recycle-types";
import { ExportButton } from "@/components/export-button";
import {
  PageHeader, Button, Card, Table, THead, TBody, TR, TH, TD,
  Badge, statusTone, EmptyState, StatTile, Input, Select, Forbidden
} from "@/components/ui";
import { formatMoney, formatPercent, humanize, formatDate, formatMoneyTotal } from "@/lib/utils";

export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; status?: string; kind?: string; partnerType?: string }>;
}) {
  const _me = await requireUser();
  const canDeleteRow = can(_me, RECYCLE_TYPES.Partner.permission);
  if (!can(_me, PERMISSIONS.PARTNER_READ)) return <Forbidden what="partners" />;

  const params = await searchParams;
  const db = await supabaseServer();

  // One wave: the list and the three summaries need nothing from each other.
  // PostgREST has neither groupBy nor aggregate, so the sums are computed here.
  const [partners, kindRes, payableRes, { data: sourcedRows }] = await Promise.all([
    listPartners(params),
    db
      .from("partner")
      .select("kind")
      .is("deletedAt", null)
      .eq("status", "ACTIVE"),
    // Owed: in progress on won deals, what the partner is actually paid.
    db
      .from("partner_commission")
      .select("partnerAmount, opportunity!inner ( stage )")
      .eq("status", "IN_PROGRESS")
      .eq("opportunity.stage", "CLOSED_WON"),
    // Deals credited to a partner, still open.
    db
      .from("opportunity")
      .select("amount, stage")
      .not("sourcePartnerId", "is", null)
      .is("deletedAt", null),
  ]);

  const kinds = kindRes.data ?? [];
  const companies = kinds.filter((p) => p.kind === "COMPANY").length;
  const individuals = kinds.filter((p) => p.kind === "INDIVIDUAL").length;

  const payableAgg = {
    _sum: {
      netPayableAmount: (payableRes.data ?? []).reduce(
        (sum, r) => sum.plus(toDecimal(r.partnerAmount)),
        toDecimal(0),
      ),
    },
  };

  const openSourced = (sourcedRows ?? [])
    .filter((d) => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage as string))
    .reduce((s, d) => s.plus(toDecimal(d.amount)), toDecimal(0));

  return (
    <>
      <PageHeader
        title="Partners"
        description="Resellers, referrers and implementation partners - companies and individuals alike."
      >
        <ExportButton entity="partners" params={{ search: params.search, status: params.status }} />
        <Button asChild>
          <Link href="/partners/new">Add partner</Link>
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Partner companies" value={String(companies)} sublabel="Active, backed by an account" />
        <StatTile label="Individual partners" value={String(individuals)} sublabel="Active, contact-only" />
        <StatTile label="Partner-sourced pipeline" value={formatMoneyTotal(openSourced)} sublabel="Open deals credited to partners" tone="info" />
        <StatTile
          label="Commission owed"
          value={formatMoneyTotal(payableAgg._sum.netPayableAmount ?? 0)}
          sublabel="On won deals, not yet paid"
          tone="warning"
          href="/commissions?view=owed"
        />
      </div>

      <Card className="mt-6">
        <form className="flex flex-wrap items-end gap-3 border-b p-4">
          <div className="min-w-[200px] flex-1">
            <Input name="search" placeholder="Search name, number or email…" defaultValue={params.search} />
          </div>
          <Select name="kind" defaultValue={params.kind ?? ""} className="w-40">
            <option value="">All kinds</option>
            <option value="COMPANY">Company</option>
            <option value="INDIVIDUAL">Individual</option>
          </Select>
          <Select name="partnerType" defaultValue={params.partnerType ?? ""} className="w-44">
            <option value="">All types</option>
            {["REFERRAL", "RESELLER", "IMPLEMENTATION", "TECHNOLOGY", "DISTRIBUTOR"].map((t) => (
              <option key={t} value={t}>{humanize(t)}</option>
            ))}
          </Select>
          <Select name="status" defaultValue={params.status ?? ""} className="w-40">
            <option value="">All statuses</option>
            {["PROSPECTIVE", "ACTIVE", "INACTIVE", "TERMINATED"].map((s) => (
              <option key={s} value={s}>{humanize(s)}</option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>

        {partners.length === 0 ? (
          <EmptyState
            title="No partners match"
            description="Partners can be a company (which also becomes an Account) or an individual referrer stored as a contact only."
            action={
              <Button asChild>
                <Link href="/partners/new">Add your first partner</Link>
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Partner</TH>
                <TH>Type / Tier</TH>
                <TH>Manager</TH>
                <TH>Commission rate</TH>
                <TH className="text-right" priority="tertiary">Deals</TH>
                <TH className="text-right">Referrals</TH>
                <TH>Agreement</TH>
                <TH>Status</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <TBody>
              {partners.map((p) => {
                const expiring =
                  p.agreementExpiryDate &&
                  p.agreementExpiryDate < new Date(Date.now() + 60 * 86_400_000);

                return (
                  <TR key={p.id}>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary">
                          {p.kind === "COMPANY" ? (
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <User className="h-4 w-4 text-muted-foreground" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <Link href={`/partners/${p.id}`} className="font-medium hover:underline">
                            {p.displayName}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {p.partnerNumber}
                            {p.kind === "INDIVIDUAL" && " · individual"}
                          </p>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <Badge tone="neutral">{humanize(p.partnerType)}</Badge>
                      <p className="mt-0.5 text-xs text-muted-foreground">{humanize(p.tier)}</p>
                    </TD>
                    <TD className="text-sm text-muted-foreground">
                      {p.partnerManager?.fullName ?? "—"}
                    </TD>
                    <TD className="text-sm">
                      {p.defaultCommissionPercent
                        ? formatPercent(p.defaultCommissionPercent)
                        : "—"}
                    </TD>
                    <TD priority="tertiary" className="text-right tabular">{p._count.opportunities}</TD>
                    <TD className="text-right tabular">{p._count.referredLeads}</TD>
                    <TD className="text-sm">
                      {p.agreementExpiryDate ? (
                        <span className={expiring ? "text-amber-600 dark:text-amber-400" : ""}>
                          {formatDate(p.agreementExpiryDate)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>
                    </TD>
                    <TD className="text-right">
                      <RowActions type="Partner" id={p.id} name={String(p.displayName ?? "")} editHref={can(_me, PERMISSIONS.PARTNER_WRITE) ? `/partners/${p.id}/edit` : null} canDelete={canDeleteRow} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
