import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { notFound } from "next/navigation";
import { getVendorBill, getPayableFormOptions } from "@/server/payables";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { AuditPanel } from "@/components/audit-panel";
import { getAuditTrail } from "@/lib/audit";
import { DocumentsPanel } from "@/components/documents-panel";
import { requireUser, can, canAny, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, DetailRow, Forbidden, Button,
} from "@/components/ui";
import { formatMoney, formatDate, formatNumber, humanize, formatMoneyTotal } from "@/lib/utils";
import { BillActions } from "./bill-actions";
import { PurchasePanel } from "../../inventory/purchase-panel";

export default async function VendorBillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.INVOICE_READ)) return <Forbidden what="vendor bills" />;

  const { id } = await params;

  const [bill, options, notes, documents, audit] = await Promise.all([
    getVendorBill(id),
    getPayableFormOptions(),
    listNotes("VendorBill", id),
    listDocuments("VendorBill", id),
    getAuditTrail("VendorBill", id, 15),
  ]);
  if (!bill) notFound();

  const outstanding = Number(bill.outstandingAmount ?? 0);

  return (
    <>
      <PageHeader
        backTo="/vendor-bills"
        backLabel="Back to vendor bills"
        title={bill.billNumber}
        description={`${bill.vendor?.name ?? "Unknown supplier"}${bill.vendorInvoiceNumber ? ` · their ref ${bill.vendorInvoiceNumber}` : ""}`}
      >
        <Badge tone={statusTone(bill.status)}>{humanize(bill.status)}</Badge>
        {bill.status === "DRAFT" && can(me, PERMISSIONS.INVOICE_WRITE) && (
          <Button asChild variant="outline"><Link href={`/vendor-bills/${bill.id}/edit`}>Edit</Link></Button>
        )}
        <CorrectControl type="VendorBill" id={bill.id as string} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatMoneyTotal(bill.totalAmount, bill.currencyCode)} />
        <StatTile
          label="Paid"
          value={formatMoney(bill.paidAmount, bill.currencyCode)}
          tone={Number(bill.paidAmount) > 0 ? "success" : "neutral"}
        />
        <StatTile
          label="Outstanding"
          value={formatMoneyTotal(outstanding, bill.currencyCode)}
          tone={outstanding > 0 ? "warning" : "success"}
        />
        <StatTile label="Due" value={formatDate(bill.dueDate)} sublabel={`Issued ${formatDate(bill.billDate)}`} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>What happens next</CardTitle>
        </CardHeader>
        <CardContent>
          <BillActions
            billId={bill.id}
            vendorAccountId={bill.vendorAccountId}
            status={bill.status}
            outstanding={outstanding}
            currencyCode={bill.currencyCode}
            banks={options.banks}
            canApprove={canAny(me, PERMISSIONS.PAYABLE_APPROVE, PERMISSIONS.INVOICE_APPROVE)}
            canPay={can(me, PERMISSIONS.PAYMENT_WRITE)}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <THead>
              <TR>
                <TH>Description</TH>
                <TH>Category</TH>
                <TH className="text-right">Qty</TH>
                <TH className="text-right">Unit cost</TH>
                <TH>Tax</TH>
                <TH className="text-right">Line total</TH>
              </TR>
            </THead>
            <TBody>
              {bill.lines.map((line: Record<string, any>) => (
                <TR key={String(line.id)}>
                  <TD className="text-sm">{line.description}</TD>
                  <TD className="text-sm text-muted-foreground">{line.category?.name ?? "—"}</TD>
                  <TD className="text-right tabular">{formatNumber(line.quantity, 2)}</TD>
                  <TD className="text-right tabular">
                    {formatMoney(line.unitCost, bill.currencyCode)}
                  </TD>
                  <TD className="text-sm text-muted-foreground">{line.taxRate?.name ?? "—"}</TD>
                  <TD className="text-right font-medium tabular">
                    {formatMoney(line.lineTotal, bill.currencyCode)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <dl className="space-y-1 border-t px-5 pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular">{formatMoney(bill.subtotal, bill.currencyCode)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular">{formatMoney(bill.taxAmount, bill.currencyCode)}</dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Total</dt>
              <dd className="tabular">{formatMoneyTotal(bill.totalAmount, bill.currencyCode)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Payments against this bill</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {bill.allocations.length === 0 ? (
              <p className="text-muted-foreground">Nothing paid yet.</p>
            ) : (
              bill.allocations.map((a: Record<string, any>) => (
                <div
                  key={String(a.id)}
                  className="flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="font-mono text-xs">{a.vendorPayment?.paymentNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(a.vendorPayment?.paymentDate)} ·{" "}
                      {humanize(a.vendorPayment?.paymentMethod ?? "")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium tabular">
                      {formatMoney(a.allocatedAmount, bill.currencyCode)}
                    </p>
                    <Badge tone={statusTone(a.vendorPayment?.status ?? "")}>
                      {humanize(a.vendorPayment?.status ?? "")}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Supplier">
              {bill.vendor ? (
                <Link href={`/accounts/${bill.vendor?.id}`} className="text-primary hover:underline">
                  {bill.vendor?.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Their invoice">{bill.vendorInvoiceNumber ?? "—"}</DetailRow>
            <DetailRow label="Project">
              {bill.project ? (
                <Link href={`/projects/${bill.project?.id}`} className="text-primary hover:underline">
                  {bill.project?.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Currency">{bill.currencyCode}</DetailRow>
            {bill.notes && (
              <DetailRow label="Notes">
                <span className="whitespace-pre-line">{bill.notes}</span>
              </DetailRow>
            )}
          </CardContent>
        </Card>
      </div>

      <PurchasePanel kind="bill" id={id} amount={Number(bill.totalAmount ?? 0)} currencyCode={bill.currencyCode} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="VendorBill" entityId={id} notes={notes} />
        <DocumentsPanel entityType="VendorBill" entityId={id} documents={documents} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}
