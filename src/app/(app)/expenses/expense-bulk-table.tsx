"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { DeleteConfirm } from "@/components/delete-confirm";
import { useCan } from "@/components/permissions";
import Link from "next/link";
import { Check, X, Send, Banknote, Receipt, Pencil } from "lucide-react";
import {
  Table, THead, TBody, TR, TH, TD, Badge, statusTone, Button, Alert,
} from "@/components/ui";
import { formatMoney, formatDate, humanize } from "@/lib/utils";
import {
  setExpenseApprovalBulk, markExpensePaidBulk, 
} from "@/server/payables";

type Expense = Record<string, any>;

/**
 * The expense table, with row selection and the actions that act on a selection.
 *
 * Which buttons appear depends on what is actually selected: approving is only
 * offered when something submitted is in the selection, settling only when
 * something approved is. The server re-checks every row regardless — this only
 * avoids offering a button that would be refused for the whole selection.
 *
 * Rows the action cannot touch are skipped and reported by name rather than
 * failing the batch, so "select all, approve" behaves the way it reads.
 */
export function ExpenseBulkTable({
  expenses,
  canApprove,
  canPay,
  canWrite,
  canAdminDelete = false,
  currentUserId,
}: {
  expenses: Expense[];
  canApprove: boolean;
  canPay: boolean;
  canWrite: boolean;
  /** An administrator deletes any claim (approved and paid included) to the recycle bin. */
  canAdminDelete?: boolean;
  currentUserId: string;
}) {
  const canDelete = useCan("record:delete");
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  // The rows an action just touched. Approving clears the selection, which
  // used to leave the screen silent about the half of the job still to do:
  // approved expenses are not paid expenses, and nothing said so.
  const [justActedOn, setJustActedOn] = useState<string[]>([]);

  const selectedRows = useMemo(
    () => expenses.filter((e) => selected.has(e.id)),
    [expenses, selected],
  );

  // What the selection can actually do, so dead buttons stay hidden.
  const counts = useMemo(() => {
    let submittable = 0;
    let approvable = 0;
    let settleable = 0;
    for (const e of selectedRows) {
      if (e.approvalStatus === "DRAFT" || e.approvalStatus === "REJECTED") submittable += 1;
      // Your own claim is not approvable by you, and the server agrees.
      // An administrator may approve their own (agreed 4 October 2026).
      if (e.approvalStatus === "SUBMITTED" && (e.employeeUserId !== currentUserId || canAdminDelete)) approvable += 1;
      if (e.approvalStatus === "APPROVED" && e.paymentStatus === "UNPAID") settleable += 1;
    }
    return { submittable, approvable, settleable };
  }, [selectedRows, currentUserId, canAdminDelete]);

  const selectedTotal = selectedRows.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);

  const allSelected = expenses.length > 0 && selected.size === expenses.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(expenses.map((e) => e.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(
    action: () => Promise<
      { ok: true; data: { updated: number; skipped: { id: string; reason: string }[] } }
      | { ok: false; error?: string }
    >,
    verb: string,
    acted: string[] = [...selected],
  ) {
    setMessage(null);
    start(async () => {
      const result = await action();

      if (!result.ok) {
        setMessage({ tone: "danger", text: result.error ?? "That did not work." });
        return;
      }

      const { updated, skipped } = result.data;
      const parts = [`${updated} expense${updated === 1 ? "" : "s"} ${verb}.`];
      if (skipped.length) {
        const shown = skipped.slice(0, 3).map((s) => `${s.id} (${s.reason})`).join(", ");
        parts.push(
          `${skipped.length} skipped: ${shown}${skipped.length > 3 ? ", …" : ""}`,
        );
      }

      setMessage({
        tone: updated === 0 ? "danger" : "success",
        text: parts.join(" "),
      });
      setJustActedOn(acted);
      setSelected(new Set());
      router.refresh();
    });
  }

  const ids = () => [...selected];

  // Why a row cannot be edited or deleted, mirroring updateExpense and
  // deleteExpense. The server still decides; this only disables a dead button.
  function lockedReason(e: Expense): string | null {
    if (e.approvalStatus === "APPROVED") return "Approved expenses are locked. Reject it back to draft first.";
    if (e.paymentStatus === "PAID") return "Paid expenses cannot be changed.";
    if (e.approvalStatus === "SUBMITTED" && !canApprove) return "Waiting on approval. Ask your approver to reject it back first.";
    return null;
  }


  // Of the rows just acted on, which are now sitting approved and unpaid.
  // Approving is only half the job — the money still has to go out — so the
  // next step is offered where the last one finished rather than left to be
  // rediscovered by selecting the same rows again.
  const readyToSettle = useMemo(
    () =>
      expenses.filter(
        (e) =>
          justActedOn.includes(e.id) &&
          e.approvalStatus === "APPROVED" &&
          e.paymentStatus === "UNPAID",
      ),
    [expenses, justActedOn],
  );

  return (
    <div className="space-y-3">
      {message && (
        <Alert tone={message.tone}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{message.text}</span>
            {canPay && readyToSettle.length > 0 && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  const target = readyToSettle.map((e) => e.id);
                  run(() => markExpensePaidBulk(target), "settled", target);
                }}
              >
                <Banknote className="h-4 w-4" /> Settle {readyToSettle.length} now
              </Button>
            )}
          </div>
          {canPay && readyToSettle.length > 0 && (
            <p className="mt-1 text-xs opacity-80">
              Approving does not pay anybody. These are waiting on the money going out.
            </p>
          )}
        </Alert>
      )}

      {selected.size > 0 && (
        // Sticky, so the actions stay reachable while scrolling a long
        // selection rather than being left at the top of the page.
        <div
          role="region"
          aria-label={`${selected.size} expenses selected`}
          className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border bg-card/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80"
        >
          <span className="text-sm font-medium">
            {selected.size} selected
            <span className="ml-2 font-normal text-muted-foreground tabular">
              {formatMoney(selectedTotal)}
            </span>
          </span>

          <div className="ml-auto flex flex-wrap gap-2">
            {counts.submittable > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => setExpenseApprovalBulk(ids(), "SUBMITTED"), "submitted")}
              >
                <Send className="h-4 w-4" /> Submit {counts.submittable}
              </Button>
            )}

            {canApprove && counts.approvable > 0 && (
              <>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => setExpenseApprovalBulk(ids(), "APPROVED"), "approved")}
                >
                  <Check className="h-4 w-4" /> Approve {counts.approvable}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => setExpenseApprovalBulk(ids(), "REJECTED"), "rejected")}
                >
                  <X className="h-4 w-4" /> Reject
                </Button>
              </>
            )}

            {canPay && counts.settleable > 0 && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => markExpensePaidBulk(ids()), "settled")}
              >
                <Banknote className="h-4 w-4" /> Settle {counts.settleable}
              </Button>
            )}

            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <Table>
        <THead>
          <TR>
            <TH className="w-10">
              <input
                type="checkbox"
                aria-label={allSelected ? "Clear selection" : "Select all expenses on this page"}
                checked={allSelected}
                // Half-selected reads as neither on nor off, which is what a
                // dash in the box means. It has no HTML attribute, so it is set
                // through the DOM node.
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && !allSelected;
                }}
                onChange={toggleAll}
                className="h-4 w-4 cursor-pointer rounded border-input"
              />
            </TH>
            {(canWrite || canAdminDelete) && <TH className="w-24">Actions</TH>}
            <TH>Expense</TH>
            <TH priority="tertiary">Category</TH>
            <TH priority="secondary">Who</TH>
            <TH priority="tertiary">Project</TH>
            <TH priority="tertiary">Date</TH>
            <TH className="text-right">Amount</TH>
            <TH>Approval</TH>
            <TH priority="secondary">Payment</TH>
          </TR>
        </THead>
        <TBody>
          {expenses.map((e) => (
            <TR
              key={e.id}
              data-selected={selected.has(e.id) || undefined}
              className={selected.has(e.id) ? "bg-primary/5" : undefined}
            >
              <TD>
                <input
                  type="checkbox"
                  aria-label={`Select ${e.expenseNumber}`}
                  checked={selected.has(e.id)}
                  onChange={() => toggleOne(e.id)}
                  className="h-4 w-4 cursor-pointer rounded border-input"
                />
              </TD>
              {(canWrite || canAdminDelete) && (
                <TD>
                  {(() => {
                    const locked = lockedReason(e);
                    return (
                      <div className="flex items-center gap-1">
                        {locked && !canAdminDelete ? (
                          <Button size="sm" variant="ghost" disabled title={locked} aria-label={`Edit ${e.expenseNumber}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button asChild size="sm" variant="ghost" title="Edit" aria-label={`Edit ${e.expenseNumber}`}>
                            <Link href={`/expenses/${e.id}/edit`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                        {canDelete && <DeleteConfirm type="Expense" id={e.id} name={e.expenseNumber} onDone={() => softReload()} />}
                      </div>
                    );
                  })()}
                </TD>
              )}
              <TD>
                <Link href={`/expenses/${e.id}`} className="font-mono text-xs hover:underline">
                  {e.expenseNumber}
                </Link>
                {e.description && (
                  <p className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {e.description}
                  </p>
                )}
              </TD>
              <TD priority="tertiary" className="text-sm">
                {e.category?.name ?? "—"}
                {e.category?.glCode && (
                  <p className="text-xs text-muted-foreground">{e.category.glCode}</p>
                )}
              </TD>
              <TD priority="secondary" className="text-sm">
                {/* Neither is set when the company paid out of petty cash and
                    the supplier was not worth recording. A bare dash there
                    reads as missing data rather than as the answer. */}
                {e.employee?.fullName ?? e.vendor?.name ?? (
                  <span className="text-muted-foreground">The company</span>
                )}
                {e.reimbursable && e.employee && (
                  <p className="text-xs text-muted-foreground">Reimbursable</p>
                )}
              </TD>
              <TD priority="tertiary" className="text-sm">
                {e.project ? (
                  <Link href={`/projects/${e.project.id}`} className="hover:underline">
                    {e.project.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {e.billableToCustomer && (
                  <Badge tone="info" className="mt-0.5">
                    <Receipt className="h-3 w-3" /> Billable
                  </Badge>
                )}
              </TD>
              <TD priority="tertiary" className="whitespace-nowrap text-sm">
                {formatDate(e.expenseDate)}
              </TD>
              <TD className="text-right font-medium tabular">
                {formatMoney(e.amount, e.currencyCode)}
              </TD>
              <TD>
                <Badge tone={statusTone(e.approvalStatus)}>{humanize(e.approvalStatus)}</Badge>
              </TD>
              <TD priority="secondary">
                <Badge tone={statusTone(e.paymentStatus)}>{humanize(e.paymentStatus)}</Badge>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
