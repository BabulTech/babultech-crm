import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { ActivitiesPanel } from "@/components/activities-panel";
import { listActivitiesFor } from "@/server/activities";
import { DocumentsPanel } from "@/components/documents-panel";
import { Building2, User, Mail, Phone, Globe, MapPin } from "lucide-react";
import { getPartner, getPartnerSummary } from "@/server/partners";
import { listPartnerPortalAccess } from "@/server/partner-access";
import { PartnerPortalPanel } from "./portal-access-panel";
import { PartnerThread } from "@/components/partner-thread";
import { getPartnerThread } from "@/server/partner-activities";
import { DEFAULT_PARTNER_EMAIL_TO } from "@/lib/partner-policy";
import { getAuditTrail } from "@/lib/audit";
import { auditFieldLabel } from "@/lib/audit-format";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, EmptyState, Button, Alert, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, humanize, serialize, formatMoneyTotal } from "@/lib/utils";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.PARTNER_READ)) return <Forbidden what="partners" />;

  const { id } = await params;

  // One wave: every read takes only the id, so none waits on another.
  const [notes, documents, portalPeople, thread, activities, partner, summary, audit] = await Promise.all([
    listNotes("Partner", id),
    listDocuments("Partner", id),
    listPartnerPortalAccess(id),
    getPartnerThread(id),
    listActivitiesFor("Partner", id),
    getPartner(id),
    getPartnerSummary(id),
    getAuditTrail("Partner", id, 15),
  ]);
  if (!partner) notFound();

  const bank = (partner.bankDetails ?? {}) as Record<string, string | undefined>;
  const agreementExpired =
    partner.agreementExpiryDate && partner.agreementExpiryDate < new Date();

  return (
    <>
      <PageHeader
        backTo="/partners"
        backLabel="Back to partners"
        title={partner.displayName}
        description={`${partner.partnerNumber} · ${humanize(partner.partnerType)} partner · ${humanize(partner.tier)} tier`}
      >
        <Badge tone={statusTone(partner.status)}>{humanize(partner.status)}</Badge>
        {can(_me, PERMISSIONS.PARTNER_WRITE) && (
          <Button asChild><Link href={`/partners/${id}/edit`}>Edit</Link></Button>
        )}
        <FavoriteControl entityType="Partner" entityId={id} label={String(partner.displayName ?? "")} />
        <RecentMark entityType="Partner" entityId={id} label={String(partner.displayName ?? "")} />
      </PageHeader>

      {agreementExpired && (
        <div className="mb-5">
          <Alert tone="warning">
            The partner agreement expired on {formatDate(partner.agreementExpiryDate)}. New deals
            credited to this partner still get commission - renew the agreement, or set the partner to
            Inactive to stop that.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Open pipeline" value={formatMoneyTotal(summary.openPipeline)} sublabel={`${summary.dealsOpen} live deals`} tone="info" />
        <StatTile label="Won value" value={formatMoneyTotal(summary.wonValue)} sublabel={`${summary.dealsWon} won · ${summary.dealsLost} lost`} tone="success" />
        <StatTile
          label="Win rate"
          value={summary.winRate === null ? "—" : `${summary.winRate.toFixed(0)}%`}
          sublabel="Closed deals only"
        />
        <StatTile label="Commission owed" value={formatMoneyTotal(summary.commissionPayable)} sublabel={`${formatMoney(summary.commissionPaid)} paid to date`} tone="warning" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {partner.kind === "COMPANY" ? <Building2 className="h-4 w-4" /> : <User className="h-4 w-4" />}
              {partner.kind === "COMPANY" ? "Company partner" : "Individual partner"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {partner.kind === "COMPANY" && partner.account && (
              <Row label="Account">
                <Link href={`/accounts/${partner.account?.id}`} className="text-primary hover:underline">
                  {partner.account?.name}
                </Link>
              </Row>
            )}
            {partner.kind === "INDIVIDUAL" && partner.contact && (
              <Row label="Contact">
                <span>
                  {partner.contact?.firstName} {partner.contact?.lastName}
                </span>
                {!partner.contact?.accountId && (
                  <p className="text-xs text-muted-foreground">Not linked to any company - by design.</p>
                )}
              </Row>
            )}
            <Row label="Partner manager">{partner.partnerManager?.fullName ?? "Unassigned"}</Row>
            <Row label="Territory">
              {partner.territory ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  {partner.territory}
                </span>
              ) : "—"}
            </Row>
            <Row label="Email">
              {partner.email ? (
                <a href={`mailto:${partner.email}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                  <Mail className="h-3.5 w-3.5" />
                  {partner.email}
                </a>
              ) : "—"}
            </Row>
            <Row label="Phone">
              {partner.phone ? (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                  {partner.phone}
                </span>
              ) : "—"}
            </Row>
            <Row label="Website">
              {partner.website ? (
                <a href={partner.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  <Globe className="h-3.5 w-3.5" />
                  Visit
                </a>
              ) : "—"}
            </Row>
            <Row label="Agreement">
              {partner.startDate ? formatDate(partner.startDate) : "—"}
              {partner.agreementExpiryDate && ` → ${formatDate(partner.agreementExpiryDate)}`}
            </Row>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Commission terms</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <Row label="Commission rate">{formatPercent(partner.defaultCommissionPercent)}</Row>
              <Row label="Worked out on">The deal&apos;s final amount, after discounts, tax included</Row>
              <Row label="Paid">90 days after the deal is won</Row>
            </div>
            <p className="text-muted-foreground">
              Every deal credited to this partner gets a commission record at this rate, less the
              withholding tax below. The partner can ask for a different rate on a deal; you approve or
              decline it on the commission record.
            </p>

            <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">
              <Row label="Payout currency">{partner.payoutCurrencyCode}</Row>
              <Row label="Withholding tax">{formatPercent(partner.withholdingTaxPercent)}</Row>
              <Row label="Tax number">{partner.taxNumber ?? "—"}</Row>
              <Row label="Bank">{bank.bankName ?? "—"}</Row>
              <Row label="Account title">{bank.accountTitle ?? "—"}</Row>
              <Row label="IBAN / account">{bank.iban ?? bank.accountNumber ?? "—"}</Row>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <PartnerPortalPanel
          partnerId={id}
          people={portalPeople}
          canManage={can(_me, PERMISSIONS.PARTNER_WRITE)}
        />
      </div>

      <div className="mt-6">
        <PartnerThread
          partnerId={id}
          messages={serialize(thread) as never}
          side="INTERNAL"
          otherPartyName={partner.displayName}
          defaultEmailTo={partner.email ?? DEFAULT_PARTNER_EMAIL_TO}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Deals ({partner.opportunities.length})</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {partner.opportunities.length === 0 ? (
            <div className="px-5">
              <EmptyState
                title="No deals yet"
                description="Deals appear here when they are raised on a customer this partner brought, or when the partner adds one in their portal."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Deal</TH>
                  <TH priority="secondary">Customer</TH>
                  <TH className="text-right">Deal value</TH>
                  <TH>Stage</TH>
                </TR>
              </THead>
              <TBody>
                {partner.opportunities.map((o: Record<string, any>) => (
                  <TR key={o.id}>
                    <TD>
                      <Link href={`/opportunities/${o.id}`} className="font-medium hover:underline">
                        {o.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{o.opportunityNumber}</p>
                    </TD>
                    <TD priority="secondary" className="text-sm">{o.account?.name}</TD>
                    <TD className="text-right tabular">{formatMoney(o.amount, o.currencyCode)}</TD>
                    <TD>
                      <Badge tone={statusTone(o.stage)}>{humanize(o.stage)}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Commission ({partner.commissions.length})</CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link href={`/commissions?partnerId=${partner.id}`}>Open in commission list</Link>
          </Button>
        </CardHeader>
        <CardContent className="px-0">
          {partner.commissions.length === 0 ? (
            <div className="px-5">
              <EmptyState
                title="No commission yet"
                description="A commission record is created with every deal credited to this partner."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Number</TH>
                  <TH priority="secondary">Deal</TH>
                  <TH priority="tertiary" className="text-right">Rate</TH>
                  <TH priority="tertiary" className="text-right">Commission</TH>
                  <TH className="text-right">Partner is paid</TH>
                  <TH priority="secondary">Payment date</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {partner.commissions.map((c: Record<string, any>) => (
                  <TR key={c.id}>
                    <TD className="font-mono text-xs">
                      <Link href={`/commissions/${c.id}`} className="hover:underline">{c.commissionNumber}</Link>
                    </TD>
                    <TD priority="secondary" className="text-sm">{c.opportunity?.name}</TD>
                    <TD priority="tertiary" className="text-right tabular">{formatPercent(c.commissionPercent)}</TD>
                    <TD priority="tertiary" className="text-right tabular">{formatMoney(c.commissionAmount, c.currencyCode)}</TD>
                    <TD className="text-right font-medium tabular">{formatMoney(c.partnerAmount, c.currencyCode)}</TD>
                    <TD priority="secondary" className="text-sm">{c.paymentDate ? formatDate(c.paymentDate) : "When won"}</TD>
                    <TD>
                      <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Referred leads ({partner.referredLeads.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {partner.referredLeads.length === 0 ? (
              <p className="px-5 pb-2 text-sm text-muted-foreground">No referrals recorded.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Lead</TH>
                    <TH>Company</TH>
                    <TH className="text-right">Est. value</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {partner.referredLeads.map((l: Record<string, any>) => (
                    <TR key={l.id}>
                      <TD className="text-sm">
                        {l.firstName} {l.lastName}
                      </TD>
                      <TD className="text-sm text-muted-foreground">{l.companyName ?? "—"}</TD>
                      <TD className="text-right tabular">{formatMoney(l.estimatedValue)}</TD>
                      <TD>
                        <Badge tone={statusTone(l.status)}>{humanize(l.status)}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change history</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {audit.length === 0 ? (
              <p className="px-5 pb-2 text-sm text-muted-foreground">No changes recorded yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {audit.map((a: Record<string, any>) => (
                  <li key={a.id} className="px-5 py-2.5">
                    <p>
                      <span className="font-medium">{auditFieldLabel(a.fieldName)}</span>{" "}
                      <span className="text-muted-foreground">
                        {a.oldValue ?? "empty"} → {a.newValue ?? "empty"}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.changedBy?.fullName ?? "System"} · {formatDate(a.changedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>


      <div className="mt-6">
        <ActivitiesPanel
          entityType="Partner"
          entityId={id}
          activities={activities}
          canWrite={can(_me, PERMISSIONS.LEAD_WRITE)}
        />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Partner" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Partner" entityId={id} documents={documents} />
        <RecordEmail entityType="Partner" entityId={id} />
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
