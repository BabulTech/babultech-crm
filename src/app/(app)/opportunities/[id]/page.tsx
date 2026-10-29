import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { Timeline } from "@/components/timeline";
import { DealAttribution } from "@/components/deal-attribution";
import { DeleteControl } from "@/components/delete-control";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { FollowControl } from "@/components/follow-control";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { DocumentsPanel } from "@/components/documents-panel";
import { RecordTabs } from "@/components/record-tabs";
import { getOpportunity } from "@/server/opportunities";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getAuditTrail } from "@/lib/audit";
import { auditFieldLabel } from "@/lib/audit-format";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, Button, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, humanize, serialize, formatMoneyTotal } from "@/lib/utils";
import { DealPartnerPanel, StageControl } from "./partner-panel";
import { getCommissionForOpportunity } from "@/server/partner-commissions";
import { OpportunityProductServices } from "@/components/deal-product-services";
import { getOpportunityPricing } from "@/server/opportunity-lines";
import { ActivitiesPanel } from "@/components/activities-panel";
import { listActivitiesFor } from "@/server/activities";

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.OPPORTUNITY_READ)) return <Forbidden what="opportunities" />;

  const { id } = await params;

  // One wave: none of these needs a result from another, and each extra wave
  // costs a full round trip against a database ~400ms away.
  const canSeeCommission = can(_me, PERMISSIONS.COMMISSION_READ);
  const [notes, documents, opp, availablePartners, audit, pricing, commission, activities] = await Promise.all([
    listNotes("Opportunity", id),
    listDocuments("Opportunity", id),
    getOpportunity(id),
    (async () => {
      const db = await supabaseServer();
      const { data } = await db
        .from("partner")
        .select("id, displayName, partnerNumber")
        .is("deletedAt", null)
        .eq("status", "ACTIVE")
        .order("displayName");
      return data ?? [];
    })(),
    getAuditTrail("Opportunity", id, 15),
    getOpportunityPricing(id),
    canSeeCommission ? getCommissionForOpportunity(id) : Promise.resolve(null),
    // Including the calls and meetings a partner logs on their deal in the portal.
    listActivitiesFor("Opportunity", id),
  ]);
  if (!opp) notFound();
  const acceptedQuote = opp.quotations.find((q: Record<string, any>) => q.status === "ACCEPTED");

  return (
    <>
      <PageHeader
        backTo="/opportunities"
        backLabel="Back to opportunities"
        title={opp.name} description={`${opp.opportunityNumber} · ${opp.account?.name}`}>
        <Badge tone={statusTone(opp.stage)}>{humanize(opp.stage)}</Badge>
        {opp.stage === "CLOSED_WON" && opp.ownerUserId === _me.id && can(_me, PERMISSIONS.OPPORTUNITY_WRITE) && <Button asChild variant="outline"><Link href={`/projects/handoffs?opportunityId=${opp.id}`}>Delivery handoff</Link></Button>}
        <Button asChild variant="outline">
          <Link href={`/opportunities/${opp.id}/edit`}>Edit</Link>
        </Button>
        <FollowControl entityType="Opportunity" entityId={id} />
        <CorrectControl type="Opportunity" id={id} />
        <FavoriteControl entityType="Opportunity" entityId={id} label={String(opp.name ?? "")} />
        <RecentMark entityType="Opportunity" entityId={id} label={String(opp.name ?? "")} />
        <DeleteControl type="Opportunity" id={id} name={String(opp.name ?? "")} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Deal value" value={formatMoneyTotal(opp.amount, opp.currencyCode)} />
        <StatTile
          label="Weighted"
          value={formatMoney(
            (Number(opp.amount) * Number(opp.probabilityPercent)) / 100,
            opp.currencyCode,
          )}
          sublabel={`${Number(opp.probabilityPercent).toFixed(0)}% probability`}
          tone="info"
        />
        <StatTile label="Expected close" value={formatDate(opp.expectedCloseDate)} sublabel={humanize(opp.opportunityType)} />
        {commission ? (
          <StatTile
            label="Partner commission"
            value={formatMoney(commission.partnerAmount, commission.currencyCode)}
            sublabel={`${formatPercent(commission.commissionPercent, 2)} · ${humanize(commission.status)}`}
            tone={commission.status === "PAID" ? "success" : commission.status === "REJECTED" ? "neutral" : "warning"}
          />
        ) : (
          <StatTile
            label="Partner"
            value={opp.sourcePartner?.displayName ?? "None"}
            sublabel={opp.sourcePartner ? "Brought this customer" : "Sold by our own team"}
          />
        )}
      </div>

      {/* Tabbed for the same reason the project page was: seven panels in one
          column means the reader scrolls past everything to reach anything, and
          nothing on screen says which parts matter.

          The header, badges and figures stay outside - they answer "is this deal
          healthy?", which is the question someone opens the page with. */}
      <DealAttribution opportunityId={id} />
      <div className="mt-6" />
      <RecordTabs
        tabs={[
          {
            value: "deal",
            label: "The deal",
            content: (
              <div className="space-y-6">
          <DealPartnerPanel
            opportunityId={opp.id}
            partner={opp.sourcePartner}
            commission={commission ? (serialize(commission) as never) : null}
            canSeeCommission={canSeeCommission}
            canSetPartner={can(_me, PERMISSIONS.OPPORTUNITY_WRITE)}
            availablePartners={availablePartners}
          />

          {pricing && (
            <OpportunityProductServices
              opportunityId={opp.id}
              pricing={pricing}
              canWrite={can(_me, PERMISSIONS.OPPORTUNITY_WRITE)}
            />
          )}

          <ActivitiesPanel
            entityType="Opportunity"
            entityId={opp.id}
            activities={activities}
            canWrite={can(_me, PERMISSIONS.LEAD_WRITE)}
          />

              </div>
            ),
          },
          {
            value: "timeline",
            label: "Timeline",
            content: <Timeline entityType="Opportunity" id={id} />,
          },
          {
            value: "details",
            label: "Details",
            content: (
              <div className="space-y-6">
          <StageControl opportunityId={opp.id} currentStage={opp.stage} />

          {opp.projects.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Delivery</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label={opp.projects.length === 1 ? "Project" : "Projects"}>
                  {opp.projects.map((p: Record<string, any>) => (
                    <Link key={p.id} href={`/projects/${p.id}`} className="block hover:underline">
                      {p.projectNumber} · {p.name}
                    </Link>
                  ))}
                </Row>
                <p className="text-xs text-muted-foreground">
                  Services sold in hours became tasks on the project, with the hours sold as their budget.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Account">
                <Link href={`/accounts/${opp.account?.id}`} className="text-primary hover:underline">
                  {opp.account?.name}
                </Link>
              </Row>
              <Row label="Primary contact">
                {opp.primaryContact ? (
                  <Link href={`/contacts/${opp.primaryContact?.id}/edit`} className="text-primary hover:underline">
                    {opp.primaryContact?.firstName} {opp.primaryContact?.lastName}
                  </Link>
                ) : "—"}
              </Row>
              <Row label="Owner">{opp.owner?.fullName}</Row>
              <Row label="Campaign">
                {opp.campaign ? (
                  <Link href={`/campaigns/${opp.campaign.id}`} className="text-primary hover:underline">
                    {opp.campaign.name}
                  </Link>
                ) : "—"}
              </Row>
              <Row label="Lead source">{opp.leadSource ?? "—"}</Row>
              <Row label="Next step">{opp.nextStep ?? "—"}</Row>
              {opp.lossReason && <Row label="Loss reason">{opp.lossReason}</Row>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>Quotations</CardTitle>
              {/* A new quote starts as a copy of what this deal sells. Not offered
                  once a quote is accepted - only one can be - or on a closed deal. */}
              {!acceptedQuote &&
                !["CLOSED_WON", "CLOSED_LOST"].includes(opp.stage) &&
                can(_me, PERMISSIONS.OPPORTUNITY_WRITE) && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/quotations/new?opportunityId=${opp.id}`}>New quote</Link>
                  </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {opp.quotations.length === 0 ? (
                <p className="text-muted-foreground">
                  No quotes yet. A deal cannot be marked Closed Won without an accepted quotation.
                </p>
              ) : (
                opp.quotations.map((q: Record<string, any>) => (
                  <div key={q.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                    <div>
                      <Link href={`/quotations/${q.id}`} className="font-mono text-xs hover:underline">
                        {q.quoteNumber}
                      </Link>
                      <p className="text-xs text-muted-foreground">v{q.versionNumber}</p>
                    </div>
                    <div className="text-right">
                      <p className="tabular">{formatMoney(q.totalAmount, q.currencyCode)}</p>
                      <Badge tone={statusTone(q.status)}>{humanize(q.status)}</Badge>
                    </div>
                  </div>
                ))
              )}
              {acceptedQuote && (
                <p className="pt-1 text-xs text-emerald-600 dark:text-emerald-400">
                  {acceptedQuote.quoteNumber} accepted - this deal can be won.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Change history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {audit.length === 0 ? (
                <p className="text-muted-foreground">No changes recorded.</p>
              ) : (
                audit.map((a: Record<string, any>) => (
                  <div key={a.id}>
                    <p>
                      <span className="font-medium">{auditFieldLabel(a.fieldName)}</span>{" "}
                      <span className="text-muted-foreground">
                        {a.oldValue ?? "empty"} → {a.newValue ?? "empty"}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.changedBy?.fullName ?? "System"} · {formatDate(a.changedAt)}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
              </div>
            ),
          },
          {
            value: "files",
            label: "Notes & files",
            count: notes.length + documents.length,
            content: (
<div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Opportunity" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Opportunity" entityId={id} documents={documents} />
        <RecordEmail entityType="Opportunity" entityId={id} />
      </div>
            ),
          },
        ]}
      />

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
