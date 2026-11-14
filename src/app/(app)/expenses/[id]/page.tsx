import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { notFound } from "next/navigation";
import { Receipt } from "lucide-react";
import { getExpense } from "@/server/payables";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { AuditPanel } from "@/components/audit-panel";
import { getAuditTrail } from "@/lib/audit";
import { DocumentsPanel } from "@/components/documents-panel";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, DetailRow, Alert, Forbidden, Button,
} from "@/components/ui";
import { formatMoney, formatDate, formatDateTime, humanize } from "@/lib/utils";
import { ExpenseActions } from "./expense-actions";
import { PurchasePanel } from "../../inventory/purchase-panel";

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.EXPENSE_READ)) return <Forbidden what="expenses" />;

  const { id } = await params;

  const [expense, notes, documents, audit] = await Promise.all([
    getExpense(id),
    listNotes("Expense", id),
    listDocuments("Expense", id),
    getAuditTrail("Expense", id, 15),
  ]);
  if (!expense) notFound();

  const gross = Number(expense.amount ?? 0) + Number(expense.taxAmount ?? 0);
  const isOwnClaim = expense.employeeUserId === me.id;

  // Mirrors the rules in updateExpense: approved or paid money is locked, and a
  // claim already in the approval queue belongs to its approver. The server
  // enforces it; this decides whether to offer the button at all, because
  // sending someone to a form that turns them away is worse than not offering.
  const canEdit =
    can(me, PERMISSIONS.EXPENSE_WRITE) &&
    expense.approvalStatus !== "APPROVED" &&
    expense.paymentStatus !== "PAID" &&
    (expense.approvalStatus !== "SUBMITTED" || can(me, PERMISSIONS.EXPENSE_APPROVE));
  const needsReceipt =
    expense.category?.requiresReceipt && documents.length === 0 && expense.approvalStatus !== "APPROVED";

  return (
    <>
      <PageHeader
        backTo="/expenses"
        backLabel="Back to expenses"
        title={expense.expenseNumber}
        description={expense.description ?? expense.category?.name ?? "Expense"}
      >
        <Badge tone={statusTone(expense.approvalStatus)}>{humanize(expense.approvalStatus)}</Badge>
        <Badge tone={statusTone(expense.paymentStatus)}>{humanize(expense.paymentStatus)}</Badge>
        {expense.billableToCustomer && (
          <Badge tone="info">
            <Receipt className="h-3 w-3" /> Billable
          </Badge>
        )}
        {canEdit && (
          <Button asChild variant="outline">
            <Link href={`/expenses/${expense.id}/edit`}>Edit</Link>
          </Button>
        )}
        <CorrectControl type="Expense" id={id} />
      </PageHeader>

      {needsReceipt && (
        <div className="mb-5">
          <Alert tone="warning">
            {expense.category?.name} claims need a receipt. Attach one below before submitting,
            an approver has nothing to check against without it.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Amount" value={formatMoney(expense.amount, expense.currencyCode)} />
        <StatTile
          label="Tax"
          value={expense.taxAmount ? formatMoney(expense.taxAmount, expense.currencyCode) : "—"}
          sublabel={expense.taxAmount ? `${formatMoney(gross, expense.currencyCode)} gross` : undefined}
        />
        <StatTile label="Incurred" value={formatDate(expense.expenseDate)} />
        <StatTile
          label={expense.reimbursable ? "Owed to" : "Paid to"}
          value={
            expense.employee?.fullName ??
            expense.vendor?.name ??
            (expense.reimbursable ? "Nobody named" : "A supplier, not recorded")
          }
          sublabel={expense.reimbursable ? "Reimbursable" : "The company paid directly"}
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>What happens next</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseActions
            expenseId={expense.id}
            approvalStatus={expense.approvalStatus}
            paymentStatus={expense.paymentStatus}
            canApprove={can(me, PERMISSIONS.EXPENSE_APPROVE)}
            canPay={can(me, PERMISSIONS.EXPENSE_APPROVE)}
            // An administrator's own claims need nobody else (agreed 4 October 2026).
            isOwnClaim={isOwnClaim && !can(me, PERMISSIONS.ADMIN)}
            approvesOnSubmit={can(me, PERMISSIONS.ADMIN)}
          />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Category">
              {expense.category?.name ?? "—"}
              {expense.category?.glCode && (
                <span className="ml-2 text-xs text-muted-foreground">{expense.category.glCode}</span>
              )}
            </DetailRow>
            <DetailRow label="Paid by">
              {expense.employee?.fullName ??
                expense.vendor?.name ?? (
                  <span className="text-muted-foreground">
                    The company, no supplier recorded
                  </span>
                )}
            </DetailRow>
            <DetailRow label="Project">
              {expense.project ? (
                <Link href={`/projects/${expense.project?.id}`} className="text-primary hover:underline">
                  {expense.project?.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Customer">
              {expense.project?.account ? (
                <Link
                  href={`/accounts/${expense.project?.account?.id}`}
                  className="text-primary hover:underline"
                >
                  {expense.project?.account?.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Billable">
              {expense.billableToCustomer ? "Yes - recharged to the customer" : "No - absorbed"}
            </DetailRow>
            <DetailRow label="Recorded">{formatDateTime(expense.createdAt)}</DetailRow>
          </CardContent>
        </Card>

        <NotesSection entityType="Expense" entityId={id} notes={notes} />
      </div>

      <PurchasePanel
        kind="expense"
        id={id}
        amount={Number(expense.amount ?? 0)}
        currencyCode={expense.currencyCode}
        likelyAssets={expense.category?.name?.toLowerCase() === "asset purchase"}
      />

      <div className="mt-6">
        <DocumentsPanel entityType="Expense" entityId={id} documents={documents} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} title="Expense history" />
      </div>
    </>
  );
}
