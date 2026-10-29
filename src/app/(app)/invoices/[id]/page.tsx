import { RecordEmail } from "@/components/record-email";
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
import { sendInvoice, listEmails, isEmailConfigured } from "@/server/email";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, DetailRow, Alert, Button, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, formatNumber, humanize, daysBetween, formatMoneyTotal } from "@/lib/utils";
import { InvoiceActions } from "./invoice-actions";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [notes, documents, emails, emailConfigured, audit] = await Promise.all([
    listNotes("Invoice", id),
    listDocuments("Invoice", id),
    listEmails("Invoice", id),
    isEmailConfigured(),
    getAuditTrail("Invoice", id, 15),
  ]);

  // Bound here rather than passed through the client, where the id could be
  // rewritten to send someone else's invoice.
  const sendInvoiceHere = sendInvoice.bind(null, id);
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.INVOICE_READ)) return <Forbidden what="invoices" />;
  const db = await supabaseServer();

  const { data: invoiceRow } = await db
    .from("invoice")
    .select(
      `*,
       account ( id, name, accountNumber ),
       contact ( id, firstName, lastName, email ),
       project ( id, projectNumber, name ),
       contract ( id, contractNumber, name ),
       milestone ( id, name, projectId ),
       lines:invoice_line (
         *,
         product ( id, name, productCode ),
         taxRate:tax_rate ( id, name, ratePercent ),
         project ( id, name )
       ),
       allocations:payment_allocation (
         *,
         payment ( id, paymentNumber, paymentDate, paymentMethod, currencyCode ),
         allocatedBy:app_user!payment_allocation_allocatedById_fkey ( id, fullName )
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  type Row = Record<string, unknown>;
  const desc = (a: unknown, b: unknown) => String(b ?? "").localeCompare(String(a ?? ""));

  const invoice = invoiceRow
    ? {
        ...invoiceRow,
        account: one(invoiceRow.account as never),
        contact: one(invoiceRow.contact as never),
        project: one(invoiceRow.project as never),
        contract: one(invoiceRow.contract as never),
        milestone: one(invoiceRow.milestone as never),
        // PostgREST cannot order an embedded relation inline.
        lines: ((invoiceRow.lines ?? []) as Row[])
          .map((l): Row => ({
            ...l,
            product: one(l.product as never),
            taxRate: one(l.taxRate as never),
            project: one(l.project as never),
          }))
          .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)),
        allocations: ((invoiceRow.allocations ?? []) as Row[])
          .map((a): Row => ({
            ...a,
            payment: one(a.payment as never),
            allocatedBy: one(a.allocatedBy as never),
          }))
          .sort((a, b) => desc(a.allocatedAt, b.allocatedAt)),
      }
    : null;

  if (!invoice) notFound();

  const outstanding = Number(invoice.outstandingAmount);
  const total = Number(invoice.totalAmount);
  const paidPercent = total > 0 ? (Number(invoice.paidAmount) / total) * 100 : 0;
  const daysOverdue = daysBetween(invoice.dueDate, new Date());
  const overdue = outstanding > 0 && daysOverdue > 0 && !["DRAFT", "CANCELLED", "PAID"].includes(invoice.status);

  return (
    <>
      <PageHeader
        backTo="/invoices"
        backLabel="Back to invoices"
        title={invoice.invoiceNumber}
        description={`${invoice.account?.name} · issued ${formatDate(invoice.invoiceDate)}`}
      >
        <Badge tone={statusTone(invoice.status)}>{humanize(invoice.status)}</Badge>
        {["DRAFT", "APPROVED"].includes(invoice.status) && (
          <Button asChild variant="outline">
            <Link href={`/invoices/${invoice.id}/edit`}>Edit</Link>
          </Button>
        )}
        <CorrectControl type="Invoice" id={id} />
        <FavoriteControl entityType="Invoice" entityId={id} label={String(invoice.invoiceNumber ?? "")} />
        <RecentMark entityType="Invoice" entityId={id} label={String(invoice.invoiceNumber ?? "")} />
      </PageHeader>

      {overdue && (
        <div className="mb-5">
          <Alert tone="danger">
            {formatMoney(outstanding, invoice.currencyCode)} is {daysOverdue} day(s) overdue.
          </Alert>
        </div>
      )}
      {Number(invoice.writeOffAmount) > 0 && (
        <div className="mb-5">
          <Alert tone="warning">
            {formatMoney(invoice.writeOffAmount, invoice.currencyCode)} has been written off against
            this invoice.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatMoneyTotal(invoice.totalAmount, invoice.currencyCode)} />
        <StatTile
          label="Paid"
          value={formatMoney(invoice.paidAmount, invoice.currencyCode)}
          sublabel={`${formatPercent(paidPercent, 0)} settled`}
          tone={paidPercent >= 100 ? "success" : paidPercent > 0 ? "info" : "neutral"}
        />
        <StatTile
          label="Outstanding"
          value={formatMoneyTotal(invoice.outstandingAmount, invoice.currencyCode)}
          tone={outstanding > 0 ? (overdue ? "danger" : "warning") : "success"}
        />
        <StatTile
          label="Due"
          value={formatDate(invoice.dueDate)}
          sublabel={invoice.paymentTermsDays ? `${invoice.paymentTermsDays} day terms` : undefined}
          tone={overdue ? "danger" : "neutral"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {invoice.lines.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">This invoice has no lines.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Description</TH>
                      <TH priority="secondary" className="text-right">Qty</TH>
                      <TH priority="secondary" className="text-right">Unit price</TH>
                      <TH priority="tertiary" className="text-right">Discount</TH>
                      <TH priority="tertiary">Tax</TH>
                      <TH className="text-right">Total</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {invoice.lines.map((l: Record<string, any>) => (
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
                          {l.project && (
                            <Link href={`/projects/${l.project?.id}`} className="text-xs text-primary hover:underline">
                              {l.project?.name}
                            </Link>
                          )}
                          {/* Qty × unit price is the arithmetic that explains
                              the total, so on a phone it moves under the
                              description instead of disappearing - a line
                              total nobody can check is not worth showing. */}
                          <p className="mt-0.5 text-xs tabular text-muted-foreground sm:hidden">
                            {formatNumber(l.quantity, 2)} × {formatMoney(l.unitPrice, invoice.currencyCode)}
                            {Number(l.discountPercent ?? 0) > 0 && ` − ${formatPercent(l.discountPercent)}`}
                          </p>
                        </TD>
                        <TD priority="secondary" className="text-right tabular">{formatNumber(l.quantity, 2)}</TD>
                        <TD priority="secondary" className="whitespace-nowrap text-right tabular">{formatMoney(l.unitPrice, invoice.currencyCode)}</TD>
                        <TD priority="tertiary" className="text-right tabular">{formatPercent(l.discountPercent)}</TD>
                        <TD priority="tertiary" className="text-sm text-muted-foreground">{l.taxRate?.name ?? "—"}</TD>
                        <TD className="whitespace-nowrap text-right font-medium tabular">{formatMoney(l.lineTotal, invoice.currencyCode)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}

              <div className="mt-3 space-y-1 border-t px-5 pt-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular">{formatMoney(invoice.subtotal, invoice.currencyCode)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular">−{formatMoney(invoice.discountAmount, invoice.currencyCode)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular">{formatMoney(invoice.taxAmount, invoice.currencyCode)}</span></div>
                <div className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span className="tabular">{formatMoneyTotal(invoice.totalAmount, invoice.currencyCode)}</span></div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments applied</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {invoice.allocations.length === 0 ? (
                <p className="px-5 pb-2 text-sm text-muted-foreground">Nothing received against this invoice.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Payment</TH>
                      <TH priority="secondary">Received</TH>
                      <TH priority="tertiary">Method</TH>
                      <TH priority="tertiary">Applied by</TH>
                      <TH className="text-right">Amount</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {invoice.allocations.map((a: Record<string, any>) => (
                      <TR key={a.id}>
                        <TD className="font-mono text-xs">
                          {a.payment?.paymentNumber}
                          {/* When a payment landed is the first thing anyone
                              asks about it. */}
                          <p className="mt-0.5 font-sans text-xs text-muted-foreground sm:hidden">
                            {formatDate(a.payment?.paymentDate)}
                          </p>
                        </TD>
                        <TD priority="secondary" className="text-sm">{formatDate(a.payment?.paymentDate)}</TD>
                        <TD priority="tertiary" className="text-sm text-muted-foreground">{humanize(a.payment?.paymentMethod)}</TD>
                        <TD priority="tertiary" className="text-sm text-muted-foreground">{a.allocatedBy?.fullName ?? "System"}</TD>
                        <TD className="whitespace-nowrap text-right font-medium tabular">
                          {formatMoney(a.allocatedAmount, invoice.currencyCode)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <InvoiceActions
            invoiceId={invoice.id}
            status={invoice.status}
            outstanding={String(invoice.outstandingAmount)}
            currency={invoice.currencyCode}
          />

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Customer">
                <Link href={`/accounts/${invoice.account?.id}`} className="text-primary hover:underline">
                  {invoice.account?.name}
                </Link>
                <p className="text-xs text-muted-foreground">{invoice.account?.accountNumber}</p>
              </DetailRow>
              <DetailRow label="Bill to">
                {invoice.contact ? (
                  <Link href={`/contacts/${invoice.contact?.id}/edit`} className="text-primary hover:underline">
                    {invoice.contact?.firstName} {invoice.contact?.lastName}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Project">
                {invoice.project ? (
                  <Link href={`/projects/${invoice.project?.id}`} className="text-primary hover:underline">
                    {invoice.project?.projectNumber} - {invoice.project?.name}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Contract">
                {invoice.contract ? (
                  <Link href={`/contracts/${invoice.contract.id}`} className="text-primary hover:underline">
                    {invoice.contract.contractNumber}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Milestone">
                {invoice.milestone ? (
                  <Link href={`/projects/${invoice.milestone?.projectId}`} className="text-primary hover:underline">
                    {invoice.milestone?.name}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Currency">{invoice.currencyCode}</DetailRow>
              <DetailRow label="Sent">{formatDate(invoice.sentAt)}</DetailRow>
            </CardContent>
          </Card>


          {invoice.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{invoice.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-6">
        <SendEmailPanel
          documentLabel="invoice"
          defaultTo={invoice.contact?.email ?? null}
          defaultSubject={`Invoice ${invoice.invoiceNumber} from BabulTech`}
          defaultMessage={`Dear ${invoice.contact?.firstName ?? "Sir or Madam"},

Please find our invoice below. Payment details are as per our agreed terms.

Do let me know if anything needs clarifying.`}
          configured={emailConfigured}
          emails={emails}
          send={sendInvoiceHere}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Invoice" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Invoice" entityId={id} documents={documents} />
        <RecordEmail entityType="Invoice" entityId={id} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}
