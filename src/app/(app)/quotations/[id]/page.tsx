import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { AuditPanel } from "@/components/audit-panel";
import { getAuditTrail } from "@/lib/audit";
import { DocumentsPanel } from "@/components/documents-panel";
import { SendEmailPanel } from "@/components/send-email-panel";
import { sendQuotation, listEmails, isEmailConfigured } from "@/server/email";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, DetailRow, Alert, Button, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, formatNumber, humanize, formatMoneyTotal } from "@/lib/utils";
import { QuoteActions } from "./quote-actions";
import { getQuoteApprovalReason } from "@/server/quotations";

/** A line's four costs together, as the deal's lines show them. */
const costsOf = (l: Record<string, unknown>) =>
  Number(l.licenseCost ?? 0) + Number(l.maintenanceCost ?? 0) + Number(l.cloudCost ?? 0) + Number(l.aiCost ?? 0);

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.OPPORTUNITY_READ)) return <Forbidden what="quotations" />;
  const db = await supabaseServer();

  // The quote itself is read in the same wave as everything around it.
  const [notes, documents, emails, emailConfigured, audit, ruleReason, { data: quoteRow }] = await Promise.all([
    listNotes("Quotation", id),
    listDocuments("Quotation", id),
    listEmails("Quotation", id),
    isEmailConfigured(),
    getAuditTrail("Quotation", id, 15),
    getQuoteApprovalReason(id).catch(() => null),
    db
    .from("quotation")
    .select(
      `*,
       account ( id, name, accountNumber ),
       contact ( id, firstName, lastName, email ),
       opportunity (
         id, opportunityNumber, name, stage,
         owner:app_user!opportunity_ownerUserId_fkey ( id, fullName )
       ),
       lines:quote_line (
         *,
         product ( id, name, productCode ),
         taxRate:tax_rate ( id, name, ratePercent )
       ),
       contracts:contract ( id, contractNumber, name, status ),
       approvalDecidedBy:app_user!quotation_approvalDecidedById_fkey ( fullName )`,
    )
    .eq("id", id)
    .maybeSingle(),
  ]);

  if (!quoteRow) notFound();

  type Row = Record<string, unknown>;
  const opportunity = one(quoteRow.opportunity as never) as Row | null;

  // Bound here rather than passed through the client, where the id could be
  // rewritten to send someone else's quotation.
  const sendQuotationHere = sendQuotation.bind(null, id);

  const quote = {
    ...quoteRow,
    account: one(quoteRow.account as never),
    contact: one(quoteRow.contact as never),
    opportunity: opportunity
      ? { ...opportunity, owner: one(opportunity.owner as never) }
      : null,
    // PostgREST cannot order an embedded relation inline.
    lines: ((quoteRow.lines ?? []) as Row[])
      .map((l): Row => ({
        ...l,
        product: one(l.product as never),
        taxRate: one(l.taxRate as never),
      }))
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)),
    contracts: (quoteRow.contracts ?? []) as Row[],
    approvalDecidedBy: one(quoteRow.approvalDecidedBy as never) as { fullName: string } | null,
  };

  // A quote a partner prepared goes to the customer only once approved. Who
  // prepared it is read with our key: the quote is one this reader may see, and
  // an approver needs the name whether or not they may open partner records.
  const awaitingApproval = Boolean(quote.preparedByPartnerId) && quote.approvalStatus !== "APPROVED";
  const preparedBy = quote.preparedByPartnerId
    ? ((await supabaseAdmin().from("partner").select("id, displayName").eq("id", quote.preparedByPartnerId).maybeSingle())
        .data as { id: string; displayName: string } | null)
    : null;
  const preparedByName = preparedBy?.displayName ?? (quote.preparedByPartnerId ? "a partner" : null);

  // expiryDate is an ISO string, so parse before comparing — otherwise this is
  // always false and an expired quote never shows as expired.
  const expired =
    new Date(quote.expiryDate as string) < new Date() &&
    !["ACCEPTED", "REJECTED"].includes(quote.status as string);

  // Other versions of the same quote — a quote is versioned per opportunity.
  const { data: versionRows } = await db
    .from("quotation")
    .select("id, quoteNumber, versionNumber, status, totalAmount")
    .eq("opportunityId", quote.opportunityId as string)
    .is("deletedAt", null)
    .order("versionNumber", { ascending: false });

  const versions = versionRows ?? [];

  return (
    <>
      <PageHeader
        backTo="/quotations"
        backLabel="Back to quotations"
        title={`${quote.quoteNumber} - v${quote.versionNumber}`}
        description={`${quote.account?.name} · ${quote.opportunity?.name}`}
      >
        <Badge tone={statusTone(quote.status)}>{humanize(quote.status)}</Badge>
        {quote.approvalStatus !== "NOT_REQUIRED" && (
          <Badge tone={statusTone(quote.approvalStatus)}>{humanize(quote.approvalStatus)}</Badge>
        )}
        {["DRAFT", "UNDER_REVIEW", "APPROVED"].includes(quote.status) && (
          <Button asChild variant="outline">
            <Link href={`/quotations/${quote.id}/edit`}>Edit</Link>
          </Button>
        )}
        {/* The accepted quote is the natural starting point for a contract:
            it already says what was agreed, for whom, and on which deal.
            Building it from the blank contract form instead meant choosing the
            customer first, because the quote list there is filtered by them,
            which is the wrong way round and reads as "no quotes exist".

            Hidden once a contract exists, so the button never invites a second
            one against the same agreement. */}
        {quote.status === "ACCEPTED" &&
          quote.contracts.length === 0 &&
          can(_me, PERMISSIONS.CONTRACT_WRITE) && (
            <Button asChild>
              <Link
                href={`/contracts/new?quotationId=${quote.id}&accountId=${quote.accountId}&opportunityId=${quote.opportunityId}`}
              >
                Create contract
              </Link>
            </Button>
          )}
        <CorrectControl type="Quotation" id={id} />
        <FavoriteControl entityType="Quotation" entityId={id} label={String(quote.quoteNumber ?? "")} />

        <RecentMark entityType="Quotation" entityId={id} label={String(quote.quoteNumber ?? "")} />
      </PageHeader>

      {expired && (
        <div className="mb-5">
          <Alert tone="warning">
            This quote expired on {formatDate(quote.expiryDate)}. Issue a new version rather than
            editing it - the customer was sent these numbers.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatMoneyTotal(quote.totalAmount, quote.currencyCode)} />
        <StatTile label="Subtotal" value={formatMoney(quote.subtotal, quote.currencyCode)} sublabel={`Discount ${formatMoney(quote.discountAmount, quote.currencyCode)}`} />
        <StatTile label="Tax" value={formatMoney(quote.taxAmount, quote.currencyCode)} />
        <StatTile
          label="Valid until"
          value={formatDate(quote.expiryDate)}
          tone={expired ? "danger" : "neutral"}
          sublabel={quote.acceptedAt ? `Accepted ${formatDate(quote.acceptedAt)}` : quote.sentAt ? `Sent ${formatDate(quote.sentAt)}` : "Not sent"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {quote.lines.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">This quote has no lines.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Description</TH>
                      <TH className="text-right">Qty</TH>
                      <TH className="text-right" priority="secondary">Unit price</TH>
                      <TH className="text-right" priority="tertiary">Costs</TH>
                      <TH className="text-right" priority="secondary">Discount</TH>
                      <TH className="text-right" priority="tertiary">Tax</TH>
                      <TH className="text-right">Total</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {quote.lines.map((l: Record<string, any>) => (
                      <TR key={l.id}>
                        <TD className="text-sm">
                          {l.product ? (
                            <Link href={`/products/${l.product?.id}`} className="font-medium hover:underline">
                              {l.product?.name}
                            </Link>
                          ) : (
                            <span className="font-medium">{l.description}</span>
                          )}
                          {l.product && <p className="text-xs text-muted-foreground">{l.description}</p>}
                        </TD>
                        <TD className="text-right tabular">{formatNumber(l.quantity, 2)}</TD>
                        <TD className="text-right tabular" priority="secondary">{formatMoney(l.unitPrice, quote.currencyCode)}</TD>
                        <TD className="text-right tabular" priority="tertiary">
                          {/* Licence, maintenance, cloud and AI, as on the deal's lines. */}
                          {costsOf(l) > 0 ? formatMoney(costsOf(l), quote.currencyCode) : "—"}
                        </TD>
                        <TD className="text-right tabular" priority="secondary">
                          {Number(l.discountPercent) > 0 ? formatPercent(l.discountPercent) : "—"}
                        </TD>
                        <TD className="text-right text-sm text-muted-foreground" priority="tertiary">
                          {/* The rate the line was priced at, which a later change to the rate does not move. */}
                          {Number(l.taxPercent) > 0 ? `${l.taxRate?.name ?? "Tax"} ${formatPercent(l.taxPercent)}` : "—"}
                        </TD>
                        <TD className="text-right font-medium tabular">{formatMoney(l.lineTotal, quote.currencyCode)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {(quote.paymentTerms || quote.termsAndConditions || quote.notes) && (
            <Card>
              <CardHeader>
                <CardTitle>Terms</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {quote.paymentTerms && <DetailRow label="Payment terms"><p className="whitespace-pre-wrap">{quote.paymentTerms}</p></DetailRow>}
                {quote.termsAndConditions && <DetailRow label="Terms and conditions"><p className="whitespace-pre-wrap">{quote.termsAndConditions}</p></DetailRow>}
                {quote.notes && <DetailRow label="Notes"><p className="whitespace-pre-wrap">{quote.notes}</p></DetailRow>}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {/* expiryDate arrives from PostgREST as a string, not a Date, so it
              is parsed before toISOString - calling it on a string throws. */}
          <QuoteActions
            quoteId={quote.id}
            status={quote.status}
            expiryDate={new Date(quote.expiryDate as string).toISOString()}
            opportunityId={quote.opportunity?.id ?? null}
            opportunityStage={quote.opportunity?.stage ?? null}
            approval={{
              preparedBy: preparedByName,
              approvalStatus: String(quote.approvalStatus),
              note: (quote.approvalNote as string | null) ?? null,
              requestedAt: (quote.approvalRequestedAt as string | null) ?? null,
              decidedBy: quote.approvalDecidedBy?.fullName ?? null,
              decidedAt: (quote.approvalDecidedAt as string | null) ?? null,
            }}
            canApprove={can(_me, PERMISSIONS.QUOTATION_APPROVE)}
            ruleReason={ruleReason}
          />

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Customer">
                <Link href={`/accounts/${quote.account?.id}`} className="text-primary hover:underline">
                  {quote.account?.name}
                </Link>
                <p className="text-xs text-muted-foreground">{quote.account?.accountNumber}</p>
              </DetailRow>
              <DetailRow label="Opportunity">
                <Link href={`/opportunities/${quote.opportunity?.id}`} className="text-primary hover:underline">
                  {quote.opportunity?.opportunityNumber} - {quote.opportunity?.name}
                </Link>
              </DetailRow>
              <DetailRow label="Contact">
                {quote.contact ? (
                  <Link href={`/contacts/${quote.contact?.id}/edit`} className="text-primary hover:underline">
                    {quote.contact?.firstName} {quote.contact?.lastName}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Deal owner">{quote.opportunity?.owner?.fullName}</DetailRow>
              {preparedBy && (
                <DetailRow label="Prepared by">
                  {can(_me, PERMISSIONS.PARTNER_READ) ? (
                    <Link href={`/partners/${preparedBy.id}`} className="text-primary hover:underline">
                      {preparedBy.displayName}
                    </Link>
                  ) : (
                    preparedBy.displayName
                  )}
                  <p className="text-xs text-muted-foreground">Partner - approved by us before it is sent</p>
                </DetailRow>
              )}
              <DetailRow label="Quote date">{formatDate(quote.quoteDate)}</DetailRow>
              <DetailRow label="Currency">{quote.currencyCode}</DetailRow>
            </CardContent>
          </Card>

          {versions.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Versions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {versions.map((v: Record<string, any>) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 border-b pb-2 last:border-0">
                    <Link
                      href={`/quotations/${v.id}`}
                      className={v.id === quote.id ? "font-semibold" : "text-primary hover:underline"}
                    >
                      v{v.versionNumber} - {v.quoteNumber}
                    </Link>
                    <div className="text-right">
                      <p className="tabular text-xs">{formatMoney(v.totalAmount, quote.currencyCode)}</p>
                      <Badge tone={statusTone(v.status)}>{humanize(v.status)}</Badge>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {quote.contracts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Contracts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {quote.contracts.map((c: Record<string, any>) => (
                  <div key={c.id} className="flex items-center justify-between gap-2">
                    <Link href={`/contracts/${c.id}`} className="text-primary hover:underline">
                      {c.contractNumber}
                    </Link>
                    <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SendEmailPanel
          documentLabel="quotation"
          defaultTo={quote.contact?.email ?? null}
          defaultSubject={`Quotation ${quote.quoteNumber} from BabulTech`}
          defaultMessage={`Dear ${quote.contact?.firstName ?? "Sir or Madam"},

Please find our quotation below for your consideration. It is valid until the date shown.

Do let me know if you would like anything adjusted.`}
          configured={emailConfigured}
          emails={emails}
          send={sendQuotationHere}
          blockedReason={
            awaitingApproval
              ? `Prepared by ${preparedByName}, so it goes to the customer only once it is approved.`
              : null
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Quotation" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Quotation" entityId={id} documents={documents} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}
