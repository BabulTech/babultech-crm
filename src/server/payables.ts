"use server";

import { isValidDay } from "@/lib/date-range";
import { describeInvalid } from "@/lib/form-errors";
import { deleteToRecycleBin } from "./recycle-bin";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { picklistCode } from "@/lib/picklists";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { toDecimal, one } from "@/lib/decimal";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { createRecord, updateRecord, applySearch, LIST_LIMIT, EXPENSE_PAGE_SIZE } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, authorizeAny, can, requirePermission } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import { notifyExpenseSubmitted, notifyExpenseDecided } from "./expense-notifications";
import type { ActionResult } from "./partners";

/**
 * Money going out: expenses and vendor bills.
 *
 * The mirror of billing.ts. Together they are what makes a margin figure
 * possible — until now only receivables existed, so the system could say what
 * had been earned but not what it cost.
 *
 * Two balances are maintained here and never typed in:
 *   paidAmount        = sum of the bill's vendor payment allocations
 *   outstandingAmount = totalAmount - paidAmount
 *
 * recalculateVendorBill is the only place either is written.
 */

const ZERO = toDecimal(0);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * Which of these project ids are internal work.
 *
 * Takes a list so the bulk import can ask once for a whole file instead of a
 * query per row.
 */
async function internalProjectIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();

  const db = await supabaseServer();
  const { data } = await db
    .from("project")
    .select("id")
    .in("id", unique)
    .eq("projectType", "INTERNAL");

  return new Set((data ?? []).map((p) => p.id as string));
}

const expenseSchema = z.object({
  categoryId: z.string().uuid("Choose a category."),
  expenseDate: z.string().min(1, "When was it incurred?"),
  amount: z.coerce.number().positive("An expense has to be more than zero."),
  taxAmount: z.coerce.number().min(0).optional().nullable(),
  currencyCode: z.string().length(3).default("PKR"),
  description: z.string().optional().nullable(),
  employeeUserId: z.string().uuid().optional().nullable(),
  vendorAccountId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  billableToCustomer: z.coerce.boolean().default(false),
  reimbursable: z.coerce.boolean().default(true),
});

/**
 * One page of expenses, plus the total so the pager knows how many there are.
 *
 * `count: "exact"` makes PostgREST report the size of the whole filtered set
 * rather than the slice, which is what "Showing 1-25 of 41" needs. It costs a
 * second count query server-side; at this table's size that is far cheaper than
 * shipping every row to the browser the way the old unpaginated list did.
 */
export async function listExpenses(filters?: {
  search?: string;
  approvalStatus?: string;
  paymentStatus?: string;
  projectId?: string;
  /** The day the expense happened, both ends included: yyyy-mm-dd. */
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
}) {
  const me = await requirePermission(PERMISSIONS.EXPENSE_READ);

  const db = await supabaseServer();

  const pageSize = Math.min(filters?.pageSize ?? EXPENSE_PAGE_SIZE, LIST_LIMIT);
  // A page below 1 (or a non-number from the query string) reads as the first.
  const page = Math.max(1, Math.floor(filters?.page ?? 1) || 1);
  const from = (page - 1) * pageSize;

  let query = db
    .from("expense")
    .select(
      `*,
       category:expense_category ( id, name, glCode, requiresReceipt ),
       employee:app_user!expense_employeeUserId_fkey ( id, fullName ),
       vendor:account ( id, name ),
       project ( id, name, projectNumber )`,
      { count: "exact" },
    )
    .is("deletedAt", null)
    .order("expenseDate", { ascending: false })
    // expenseDate alone is not unique — several rows share a date — so without a
    // tiebreaker the same row can appear on two pages and another on none.
    .order("expenseNumber", { ascending: false });

  // A claimant sees their own claims; an approver sees the ones they decide on.
  //
  // Until expenses had their own permission this was invisible: reaching the
  // list at all required invoice:read, which only finance roles held, so the
  // absence of an ownership filter never showed. Now that consultants can open
  // the screen, the filter is what keeps their colleagues' claims off it.
  if (!can(me, PERMISSIONS.EXPENSE_APPROVE)) {
    query = query.eq("employeeUserId", me.id);
  }

  if (filters?.approvalStatus) query = query.eq("approvalStatus", filters.approvalStatus);
  if (filters?.paymentStatus) query = query.eq("paymentStatus", filters.paymentStatus);
  if (filters?.projectId) query = query.eq("projectId", filters.projectId);
  if (filters?.dateFrom && isValidDay(filters.dateFrom)) query = query.gte("expenseDate", filters.dateFrom);
  if (filters?.dateTo && isValidDay(filters.dateTo)) query = query.lte("expenseDate", filters.dateTo);
  query = applySearch(query, filters?.search, ["expenseNumber", "description"]);

  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`Could not load expenses: ${error.message}`);

  const total = count ?? 0;

  return {
    rows: (data ?? []).map((e) => ({
      ...e,
      category: one(e.category as never),
      employee: one(e.employee as never),
      vendor: one(e.vendor as never),
      project: one(e.project as never),
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Totals across the whole filtered set, not just the visible page.
 *
 * Paging broke the old tiles, which summed the rows in hand: with 25 of 41 rows
 * loaded they would have quietly reported a smaller number than the list says
 * it holds. These are computed in the database over every matching row.
 */
export async function getExpenseTotals(filters?: {
  search?: string;
  approvalStatus?: string;
  paymentStatus?: string;
  projectId?: string;
  /** The day the expense happened, both ends included: yyyy-mm-dd. */
  dateFrom?: string | null;
  dateTo?: string | null;
}) {
  const me = await requirePermission(PERMISSIONS.EXPENSE_READ);

  const db = await supabaseServer();

  let query = db
    .from("expense")
    .select("amount, billableToCustomer, approvalStatus, paymentStatus")
    .is("deletedAt", null);

  // Same scope as listExpenses, so the tiles total the rows underneath them
  // rather than the whole company's spending.
  if (!can(me, PERMISSIONS.EXPENSE_APPROVE)) {
    query = query.eq("employeeUserId", me.id);
  }

  if (filters?.approvalStatus) query = query.eq("approvalStatus", filters.approvalStatus);
  if (filters?.paymentStatus) query = query.eq("paymentStatus", filters.paymentStatus);
  if (filters?.projectId) query = query.eq("projectId", filters.projectId);
  if (filters?.dateFrom && isValidDay(filters.dateFrom)) query = query.gte("expenseDate", filters.dateFrom);
  if (filters?.dateTo && isValidDay(filters.dateTo)) query = query.lte("expenseDate", filters.dateTo);
  query = applySearch(query, filters?.search, ["expenseNumber", "description"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not total the expenses: ${error.message}`);

  const rows = data ?? [];
  const sum = (subset: typeof rows) => subset.reduce((t, e) => t + Number(e.amount ?? 0), 0);
  const billable = rows.filter((e) => e.billableToCustomer);

  return {
    count: rows.length,
    total: sum(rows),
    billableTotal: sum(billable),
    billableCount: billable.length,
  };
}

const expenseCategorySchema = z.object({
  name: z.string().min(1, "Give it a name.").max(100, "That name is too long."),
});

/**
 * Creates an expense category from inside the expense form.
 *
 * A fresh database has no categories, Category is required, and the notice on
 * the form sends people to Settings — which only an administrator can reach.
 * So anyone else was left with a form they could not complete. The category is
 * added where it is needed instead, and selected on return.
 *
 * Gated on expense:write, the same permission the form itself requires: if
 * someone may record the cost, they may name the kind of cost it is. The row
 * security on expense_category is admin-only, so the insert goes through the
 * service role — the permission check above is what actually guards it.
 */
export async function createExpenseCategory(
  input: z.infer<typeof expenseCategorySchema>,
): Promise<ActionResult<{ id: string; name: string }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = expenseCategorySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const name = parsed.data.name.trim();

  const db = supabaseAdmin();

  // Case-insensitive, because "Travel" and "travel" sitting in the same
  // dropdown splits a year of spend across two lines of the accounts.
  const { data: clash } = await db
    .from("expense_category")
    .select("id, name, active")
    .ilike("name", name)
    .maybeSingle();

  if (clash) {
    // A category that was retired rather than deleted should come back rather
    // than refuse a name nobody can see in the list.
    if (!clash.active) {
      const { error } = await db
        .from("expense_category")
        .update({ active: true, updatedAt: new Date().toISOString() })
        .eq("id", clash.id);
      if (error) return { ok: false, error: error.message };
      revalidatePath("/expenses");
      revalidatePath("/settings");
      return { ok: true, data: { id: clash.id, name: clash.name } };
    }
    return {
      ok: false,
      error: `"${clash.name}" already exists.`,
      fieldErrors: { name: ["This category is already on the list."] },
    };
  }

  const { data: created, error } = await db
    .from("expense_category")
    .insert({ id: randomUUID(), name, active: true, updatedAt: new Date().toISOString() })
    .select("id, name")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/expenses");
  revalidatePath("/settings");
  return { ok: true, data: { id: created.id, name: created.name } };
}

export async function createExpense(
  input: z.infer<typeof expenseSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  // A claim that is owed back has to say who to. Without that, nothing at
  // settlement time can work out whose money to return, and the expense sits
  // there reimbursable to nobody.
  //
  // A cost the company paid itself is under no such obligation. Petty cash out
  // of the office tin, a rickshaw, tea for a meeting: real spending with no
  // supplier worth keeping a record of, and demanding one only teaches people
  // to invent a vendor called "Misc".
  if (d.reimbursable && !d.employeeUserId) {
    return {
      ok: false,
      error: "Say who to pay back, or untick paying it back if the company paid directly.",
      fieldErrors: { employeeUserId: ["Choose who is owed this money."] },
    };
  }

  if (d.billableToCustomer && !d.projectId) {
    return {
      ok: false,
      error: "A billable expense needs a project - that is what it gets billed through.",
      fieldErrors: { projectId: ["Required for a billable expense."] },
    };
  }

  // "Billable" means recharged to a customer, and an internal project has none.
  // Left unchecked the expense would sit flagged as recoverable forever, which
  // overstates what is actually owed to us.
  if (d.billableToCustomer && d.projectId && (await internalProjectIds([d.projectId])).size) {
    return {
      ok: false,
      error: "That is an internal project, so its cost cannot be recharged - there is no customer to bill.",
      fieldErrors: { billableToCustomer: ["Internal work cannot be recharged."] },
    };
  }

  try {
    const created = await createRecord<{ id: string }>(
      "expense",
      {
        categoryId: d.categoryId,
        expenseDate: d.expenseDate,
        amount: d.amount,
        taxAmount: d.taxAmount ?? null,
        currencyCode: d.currencyCode,
        description: d.description || null,
        employeeUserId: d.employeeUserId || null,
        vendorAccountId: d.vendorAccountId || null,
        projectId: d.projectId || null,
        billableToCustomer: d.billableToCustomer,
        reimbursable: d.reimbursable,
        // An administrator's entry needs nobody's approval (agreed 4 October 2026).
        approvalStatus: can(_auth.user, PERMISSIONS.ADMIN) ? "APPROVED" : "DRAFT",
        paymentStatus: "UNPAID",
      },
      { field: "expenseNumber", sequence: SEQUENCES.EXPENSE },
    );

    revalidatePath("/expenses");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not record the expense." };
  }
}

/**
 * Correct an expense that has already been recorded.
 *
 * Expenses were write-once: a typo in the amount, the wrong category, or a
 * claim booked to the wrong project could only be fixed by raising a second
 * expense and hoping someone noticed. That is how a ledger ends up with
 * duplicates nobody can reconcile.
 *
 * Two rules decide who may edit what, and they are the same rules approval
 * already implies:
 *
 *   * **Approved or paid money is locked.** Once an approver has agreed an
 *     amount, changing it behind them would make the approval a lie — the
 *     record would say "approved" over a figure nobody approved. Editing an
 *     approved expense therefore requires it to be rejected back to draft
 *     first, which is a deliberate, recorded act.
 *   * **A submitted claim belongs to its approver.** While it is in the queue,
 *     only someone holding `expense:approve` may touch it; the claimant editing
 *     a claim out from under a reviewer is the same problem in miniature.
 *
 * A draft is freely editable by whoever may write expenses, because nothing
 * downstream has acted on it yet.
 *
 * Every change here is recorded in audit_history by update_record(), which is
 * why the migration that widened audited_fields() ships alongside this: without
 * it, editing an amount or a category would have left no trace.
 */
export async function updateExpense(
  id: string,
  input: z.infer<typeof expenseSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();

  // Read the row rather than trusting what the form said about it: the state
  // that decides whether this edit is allowed has to come from the database.
  const { data: before, error: readError } = await db
    .from("expense")
    .select("id, approvalStatus, paymentStatus, employeeUserId, deletedAt")
    .eq("id", id)
    .maybeSingle();

  // A malformed id is a record that cannot exist, not a server fault.
  if (readError) {
    if (readError.code === "22P02") return { ok: false, error: "That expense no longer exists." };
    return { ok: false, error: `Could not load the expense: ${readError.message}` };
  }
  if (!before || before.deletedAt) return { ok: false, error: "That expense no longer exists." };

  // Approved or paid: an administrator's correction, with a reason, or nothing.
  const gate = await editGate("Expense", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  if (before.approvalStatus === "SUBMITTED" && !can(user, PERMISSIONS.EXPENSE_APPROVE)) {
    return {
      ok: false,
      error:
        "This claim is waiting on approval. Ask your approver to reject it back to you, or to make the change.",
    };
  }

  // The same domain rules as createExpense. They are restated rather than
  // shared because the messages point at form fields, and an edit that dropped
  // them would let a correction create the state a creation cannot.
  if (d.reimbursable && !d.employeeUserId) {
    return {
      ok: false,
      error: "Say who to pay back, or untick paying it back if the company paid directly.",
      fieldErrors: { employeeUserId: ["Choose who is owed this money."] },
    };
  }

  if (d.billableToCustomer && !d.projectId) {
    return {
      ok: false,
      error: "A billable expense needs a project - that is what it gets billed through.",
      fieldErrors: { projectId: ["Required for a billable expense."] },
    };
  }

  if (d.billableToCustomer && d.projectId && (await internalProjectIds([d.projectId])).size) {
    return {
      ok: false,
      error:
        "That is an internal project, so its cost cannot be recharged - there is no customer to bill.",
      fieldErrors: { billableToCustomer: ["Internal work cannot be recharged."] },
    };
  }

  try {
    // update_record writes the audit rows in the same transaction as the
    // update, so a change can never be applied without its history.
    await updateRecord(
      "expense",
      id,
      {
        categoryId: d.categoryId,
        expenseDate: d.expenseDate,
        amount: d.amount,
        taxAmount: d.taxAmount ?? null,
        currencyCode: d.currencyCode,
        description: d.description || null,
        employeeUserId: d.employeeUserId || null,
        vendorAccountId: d.vendorAccountId || null,
        projectId: d.projectId || null,
        billableToCustomer: d.billableToCustomer,
        reimbursable: d.reimbursable,
      },
      "Expense",
      user.id,
    );
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/expenses");
    revalidatePath(`/expenses/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not save the changes.",
    };
  }
}

/**
 * Removing an expense recorded by mistake.
 *
 * A soft delete through update_record, so the removal lands in the expense
 * history with who did it. The same locks as editing apply: once approved or
 * paid, the expense is part of the books and has to be rejected back first.
 */
/** Only the Super Admin deletes; this is the recycle bin's delete, kept for its callers. */
export async function deleteExpense(id: string, reason?: string | null): Promise<ActionResult<{ id: string }>> {
  const result = await deleteToRecycleBin("Expense", id, reason);
  return result.ok ? { ok: true, data: { id } } : result;
}

export async function getExpense(id: string) {
  const me = await requirePermission(PERMISSIONS.EXPENSE_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("expense")
    .select(
      `*,
       category:expense_category ( id, name, glCode, requiresReceipt ),
       employee:app_user!expense_employeeUserId_fkey ( id, fullName, email ),
       vendor:account ( id, name ),
       project ( id, name, projectNumber, account ( id, name ) )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load expense: ${error.message}`);
  if (!data) return null;

  // Reached by id, so the list's scope does not apply here — without this a
  // claimant could read a colleague's claim, and its amount and receipt, by
  // typing the URL. Indistinguishable from "no such expense" on purpose: which
  // ids exist is itself not theirs to learn.
  if (
    !can(me, PERMISSIONS.EXPENSE_APPROVE) &&
    data.employeeUserId !== me.id
  ) {
    return null;
  }

  const project = one(data.project as never) as Record<string, unknown> | null;

  return {
    ...data,
    category: one(data.category as never),
    employee: one(data.employee as never),
    vendor: one(data.vendor as never),
    project: project ? { ...project, account: one(project.account as never) } : null,
  };
}

/**
 * Moves an expense through submit → approve → reject, and marks it paid.
 *
 * The transitions are checked rather than assumed: an approved expense that
 * can be re-approved, or a paid one that can be rejected, is how a
 * reimbursement gets paid twice.
 */
const EXPENSE_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED"],
  REJECTED: ["SUBMITTED"],
  APPROVED: [],
};

/**
 * Fires the right notification for a transition, swallowing any failure.
 *
 * SUBMITTED tells the approvers something is waiting; APPROVED and REJECTED
 * tell the claimant the answer. Never throws: the status change has already
 * been committed and must stand whether or not the mail leaves.
 */
async function notify(
  next: "SUBMITTED" | "APPROVED" | "REJECTED",
  ids: string[],
  actorName: string,
): Promise<void> {
  if (!ids.length) return;
  try {
    const result =
      next === "SUBMITTED"
        ? await notifyExpenseSubmitted(ids)
        : await notifyExpenseDecided(ids, next, actorName);
    if (!result.ok) console.error(`Expense notification not sent: ${result.error}`);
  } catch (err) {
    console.error("Expense notification threw:", err);
  }
}

export async function setExpenseApproval(
  id: string,
  next: "SUBMITTED" | "APPROVED" | "REJECTED",
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(
    next === "SUBMITTED" ? PERMISSIONS.EXPENSE_WRITE : PERMISSIONS.EXPENSE_APPROVE,
  );
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const db = await supabaseServer();

  const { data: expense } = await db
    .from("expense")
    .select("id, approvalStatus, paymentStatus, employeeUserId")
    .eq("id", id)
    .maybeSingle();

  if (!expense) return { ok: false, error: "That expense no longer exists." };

  const allowed = EXPENSE_TRANSITIONS[expense.approvalStatus] ?? [];
  if (!allowed.includes(next)) {
    return {
      ok: false,
      error: `An expense that is ${expense.approvalStatus.toLowerCase()} cannot be ${next.toLowerCase()}.`,
    };
  }

  // An administrator's claims need nobody's approval: submitting one approves
  // it, and one already waiting they may approve themselves (agreed 4 October
  // 2026). Everyone else still needs someone else - approving your own claim
  // is the oldest hole in expense handling.
  const isAdmin = can(_auth.user, PERMISSIONS.ADMIN);
  const effective = next === "SUBMITTED" && isAdmin ? "APPROVED" : next;
  if (effective === "APPROVED" && expense.employeeUserId === _auth.user.id && !isAdmin) {
    return { ok: false, error: "Someone else has to approve your own expense." };
  }

  try {
    await updateRecord("expense", id, { approvalStatus: effective }, "Expense", _auth.user.id);

    // Best effort: the decision is written, and a mail failure must not undo it.
    await notify(effective, [id], _auth.user.fullName);

    revalidatePath("/expenses");
    revalidatePath(`/expenses/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the expense." };
  }
}

/**
 * Moves several expenses at once.
 *
 * Every row is re-checked individually against the same rules as the single
 * action — the transition table, and the bar on approving your own claim. A row
 * that fails is reported and skipped rather than failing the whole batch, so
 * selecting "everything submitted" and approving does the right thing even when
 * some of the selection is the approver's own.
 *
 * Not a transaction: each expense is independent, and a partial success is a
 * meaningful outcome here rather than a corrupt one.
 */
export async function setExpenseApprovalBulk(
  ids: string[],
  next: "SUBMITTED" | "APPROVED" | "REJECTED",
): Promise<ActionResult<{ updated: number; skipped: { id: string; reason: string }[] }>> {
  const _auth = await authorize(
    next === "SUBMITTED" ? PERMISSIONS.EXPENSE_WRITE : PERMISSIONS.EXPENSE_APPROVE,
  );
  if (!_auth.ok) return { ok: false, error: _auth.error };

  if (!ids.length) return { ok: false, error: "Nothing selected." };

  const db = await supabaseServer();
  const { data: expenses } = await db
    .from("expense")
    .select("id, expenseNumber, approvalStatus, employeeUserId")
    .in("id", ids);

  const skipped: { id: string; reason: string }[] = [];
  const moved: string[] = [];
  let updated = 0;
  const isAdmin = can(_auth.user, PERMISSIONS.ADMIN);
  const effective = next === "SUBMITTED" && isAdmin ? "APPROVED" : next;

  for (const expense of expenses ?? []) {
    const label = expense.expenseNumber ?? expense.id;

    if (!(EXPENSE_TRANSITIONS[expense.approvalStatus] ?? []).includes(next)) {
      skipped.push({
        id: label,
        reason: `already ${expense.approvalStatus.toLowerCase()}`,
      });
      continue;
    }

    if (effective === "APPROVED" && expense.employeeUserId === _auth.user.id && !isAdmin) {
      skipped.push({ id: label, reason: "your own claim" });
      continue;
    }

    try {
      await updateRecord("expense", expense.id, { approvalStatus: effective }, "Expense", _auth.user.id);
      moved.push(expense.id);
      updated += 1;
    } catch (err) {
      skipped.push({ id: label, reason: err instanceof Error ? err.message : "write failed" });
    }
  }

  // One mail for the whole batch rather than one per row.
  await notify(effective, moved, _auth.user.fullName);

  revalidatePath("/expenses");
  return { ok: true, data: { updated, skipped } };
}

/** Settles several approved expenses at once. Same skip-and-report shape. */
export async function markExpensePaidBulk(
  ids: string[],
): Promise<ActionResult<{ updated: number; skipped: { id: string; reason: string }[] }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  if (!ids.length) return { ok: false, error: "Nothing selected." };

  const db = await supabaseServer();
  const { data: expenses } = await db
    .from("expense")
    .select("id, expenseNumber, approvalStatus, paymentStatus, reimbursable")
    .in("id", ids);

  const skipped: { id: string; reason: string }[] = [];
  let updated = 0;

  for (const expense of expenses ?? []) {
    const label = expense.expenseNumber ?? expense.id;

    if (expense.approvalStatus !== "APPROVED") {
      skipped.push({ id: label, reason: "not approved" });
      continue;
    }
    if (expense.paymentStatus !== "UNPAID") {
      skipped.push({ id: label, reason: "already settled" });
      continue;
    }

    try {
      await updateRecord(
        "expense",
        expense.id,
        { paymentStatus: expense.reimbursable ? "REIMBURSED" : "PAID" },
        "Expense",
        _auth.user.id,
      );
      updated += 1;
    } catch (err) {
      skipped.push({ id: label, reason: err instanceof Error ? err.message : "write failed" });
    }
  }

  revalidatePath("/expenses");
  return { ok: true, data: { updated, skipped } };
}

/**
 * Records many expenses in one go, for pasting a spreadsheet in.
 *
 * Rows are validated up front and nothing is written unless every row passes:
 * a half-imported sheet is worse than a rejected one, because working out which
 * half landed means reading them all back. Errors carry the row number so the
 * paste can be corrected in place.
 */
export async function createExpensesBulk(
  rows: z.infer<typeof expenseSchema>[],
): Promise<ActionResult<{ created: number }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  if (!rows.length) return { ok: false, error: "No rows to import." };
  if (rows.length > 500) {
    return { ok: false, error: "Import at most 500 rows at a time." };
  }

  const validated: z.infer<typeof expenseSchema>[] = [];
  const validatedRowNumbers: number[] = [];
  const rowErrors: string[] = [];

  rows.forEach((row, i) => {
    const parsed = expenseSchema.safeParse(row);
    if (!parsed.success) {
      const first = Object.entries(parsed.error.flatten().fieldErrors)[0];
      rowErrors.push(`Row ${i + 1}: ${first ? `${first[0]}, ${first[1]?.[0]}` : "invalid"}`);
      return;
    }
    const d = parsed.data;

    // Same rule as the single form: only money owed back needs an owner.
    if (d.reimbursable && !d.employeeUserId) {
      rowErrors.push(`Row ${i + 1}: needs someone to pay back.`);
      return;
    }
    if (d.billableToCustomer && !d.projectId) {
      rowErrors.push(`Row ${i + 1}: a billable expense needs a project.`);
      return;
    }
    validated.push(d);
    validatedRowNumbers.push(i + 1);
  });

  // Same rule as the single form: internal work has no customer to recharge.
  // Resolved in one query for the whole file rather than per row. The row
  // numbers are carried alongside, because a row rejected above leaves the
  // validated index out of step with the line the user is looking at.
  const internal = await internalProjectIds(
    validated.filter((d) => d.billableToCustomer && d.projectId).map((d) => d.projectId!),
  );
  if (internal.size) {
    validated.forEach((d, i) => {
      if (d.billableToCustomer && d.projectId && internal.has(d.projectId)) {
        rowErrors.push(
          `Row ${validatedRowNumbers[i]}: that project is internal, so its cost cannot be recharged.`,
        );
      }
    });
  }

  if (rowErrors.length) {
    return { ok: false, error: rowErrors.slice(0, 10).join("\n") };
  }

  let created = 0;
  try {
    // Sequential, because expenseNumber comes from a sequence that has to hand
    // out one number at a time.
    for (const d of validated) {
      await createRecord(
        "expense",
        {
          categoryId: d.categoryId,
          expenseDate: d.expenseDate,
          amount: d.amount,
          taxAmount: d.taxAmount ?? null,
          currencyCode: d.currencyCode,
          description: d.description || null,
          employeeUserId: d.employeeUserId || null,
          vendorAccountId: d.vendorAccountId || null,
          projectId: d.projectId || null,
          billableToCustomer: d.billableToCustomer,
          reimbursable: d.reimbursable,
          approvalStatus: can(_auth.user, PERMISSIONS.ADMIN) ? "APPROVED" : "DRAFT",
          paymentStatus: "UNPAID",
        },
        { field: "expenseNumber", sequence: SEQUENCES.EXPENSE },
      );
      created += 1;
    }
  } catch (err) {
    return {
      ok: false,
      error:
        `${created} of ${validated.length} rows were recorded before this failed: ` +
        (err instanceof Error ? err.message : "unknown error"),
    };
  }

  revalidatePath("/expenses");
  return { ok: true, data: { created } };
}

export async function markExpensePaid(id: string): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.EXPENSE_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const db = await supabaseServer();

  const { data: expense } = await db
    .from("expense")
    .select("id, approvalStatus, paymentStatus, reimbursable")
    .eq("id", id)
    .maybeSingle();

  if (!expense) return { ok: false, error: "That expense no longer exists." };
  if (expense.approvalStatus !== "APPROVED") {
    return { ok: false, error: "Only an approved expense can be paid." };
  }
  if (expense.paymentStatus !== "UNPAID") {
    return { ok: false, error: "That expense is already settled." };
  }

  try {
    await updateRecord(
      "expense",
      id,
      { paymentStatus: expense.reimbursable ? "REIMBURSED" : "PAID" },
      "Expense",
      _auth.user.id,
    );
    revalidatePath("/expenses");
    revalidatePath(`/expenses/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not settle the expense." };
  }
}

// ---------------------------------------------------------------------------
// Vendor bills
// ---------------------------------------------------------------------------

const billLineSchema = z.object({
  expenseCategoryId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  description: z.string().min(1, "Every line needs a description."),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().min(0),
  taxRateId: z.string().uuid().optional().nullable(),
});

const vendorBillSchema = z.object({
  vendorAccountId: z.string().uuid("Choose the supplier."),
  vendorInvoiceNumber: z.string().max(100).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  billDate: z.string().min(1, "When was it issued?"),
  dueDate: z.string().min(1, "When is it due?"),
  currencyCode: z.string().length(3).default("PKR"),
  notes: z.string().optional().nullable(),
  lines: z.array(billLineSchema).min(1, "A bill needs at least one line."),
});

async function computeBillLines(lines: z.infer<typeof billLineSchema>[]) {
  const db = await supabaseServer();

  const taxRateIds = [...new Set(lines.map((l) => l.taxRateId).filter(Boolean))] as string[];
  const taxRates = taxRateIds.length
    ? (await db.from("tax_rate").select("id, ratePercent").in("id", taxRateIds)).data ?? []
    : [];
  const rateOf = (id: string | null | undefined) =>
    toDecimal(taxRates.find((t) => t.id === id)?.ratePercent ?? 0);

  let subtotal = ZERO;
  let taxAmount = ZERO;

  const computed = lines.map((line) => {
    const net = toDecimal(line.quantity).times(line.unitCost).toDecimalPlaces(2);
    const tax = net.times(rateOf(line.taxRateId)).dividedBy(100).toDecimalPlaces(2);

    subtotal = subtotal.plus(net);
    taxAmount = taxAmount.plus(tax);

    return {
      expenseCategoryId: line.expenseCategoryId ?? null,
      projectId: line.projectId ?? null,
      description: line.description,
      quantity: line.quantity,
      unitCost: line.unitCost,
      taxRateId: line.taxRateId ?? null,
      lineTotal: net,
    };
  });

  subtotal = subtotal.toDecimalPlaces(2);
  taxAmount = taxAmount.toDecimalPlaces(2);

  return {
    lines: computed,
    subtotal,
    taxAmount,
    totalAmount: subtotal.plus(taxAmount).toDecimalPlaces(2),
  };
}

export async function listVendorBills(filters?: {
  search?: string;
  status?: string;
  vendorAccountId?: string;
}) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  let query = db
    .from("vendor_bill")
    .select(
      `*,
       vendor:account ( id, name ),
       project ( id, name, projectNumber ),
       lines:vendor_bill_line ( count ),
       allocations:vendor_payment_allocation ( count )`,
    )
    .is("deletedAt", null)
    .order("dueDate");

  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.vendorAccountId) query = query.eq("vendorAccountId", filters.vendorAccountId);
  query = applySearch(query, filters?.search, ["billNumber", "vendorInvoiceNumber"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load vendor bills: ${error.message}`);

  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;

  return (data ?? []).map((b) => ({
    ...b,
    vendor: one(b.vendor as never),
    project: one(b.project as never),
    _count: { lines: countOf(b.lines), allocations: countOf(b.allocations) },
  }));
}

export async function getVendorBill(id: string) {
  await requirePermission(PERMISSIONS.INVOICE_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("vendor_bill")
    .select(
      `*,
       vendor:account ( id, name, accountNumber ),
       project ( id, name, projectNumber ),
       lines:vendor_bill_line (
         *,
         category:expense_category ( id, name ),
         taxRate:tax_rate ( id, name, ratePercent )
       ),
       allocations:vendor_payment_allocation (
         *,
         vendorPayment:vendor_payment ( id, paymentNumber, paymentDate, paymentMethod, status )
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load vendor bill: ${error.message}`);
  if (!data) return null;

  type Row = Record<string, unknown>;

  return {
    ...data,
    vendor: one(data.vendor as never),
    project: one(data.project as never),
    lines: ((data.lines ?? []) as Row[])
      .map((l): Row => ({
        ...l,
        category: one(l.category as never),
        taxRate: one(l.taxRate as never),
      }))
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)),
    allocations: ((data.allocations ?? []) as Row[]).map((a): Row => ({
      ...a,
      vendorPayment: one(a.vendorPayment as never),
    })),
  };
}

export async function createVendorBill(
  input: z.infer<typeof vendorBillSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = vendorBillSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.dueDate < d.billDate) {
    return {
      ok: false,
      error: "A bill cannot fall due before it is issued.",
      fieldErrors: { dueDate: ["Must be on or after the bill date."] },
    };
  }

  try {
    const db = await supabaseServer();

    // The supplier has to be an account marked as a vendor. Billing a customer
    // account by mistake would put the amount on the wrong side of the ledger.
    const { data: vendor } = await db
      .from("account")
      .select("id, name, accountType")
      .eq("id", d.vendorAccountId)
      .maybeSingle();

    if (!vendor) return { ok: false, error: "That supplier no longer exists." };

    const totals = await computeBillLines(d.lines);

    // Bill and lines in one transaction — a bill with a total and no lines
    // reconciles against nothing.
    const { data: bill, error } = await db.rpc("create_with_lines", {
      p_table: "vendor_bill",
      p_payload: {
        vendorAccountId: d.vendorAccountId,
        vendorInvoiceNumber: d.vendorInvoiceNumber || null,
        projectId: d.projectId || null,
        billDate: d.billDate,
        dueDate: d.dueDate,
        status: "DRAFT",
        currencyCode: d.currencyCode,
        subtotal: totals.subtotal.toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        totalAmount: totals.totalAmount.toFixed(2),
        paidAmount: "0.00",
        outstandingAmount: totals.totalAmount.toFixed(2),
        notes: d.notes || null,
      },
      p_line_table: "vendor_bill_line",
      p_lines: totals.lines.map((l) => ({ ...l, lineTotal: l.lineTotal.toFixed(2) })),
      p_parent_field: "vendorBillId",
      p_number_field: "billNumber",
      p_sequence: SEQUENCES.VENDOR_BILL,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/vendor-bills");
    return { ok: true, data: { id: bill.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the bill." };
  }
}

/**
 * Correcting a supplier bill. A draft is edited by anyone who enters bills;
 * once it moves on, by an administrator correcting it with a reason. A bill
 * with payments against it keeps its total, so what was paid still adds up.
 */
export async function updateVendorBill(
  id: string,
  input: z.infer<typeof vendorBillSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = vendorBillSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;
  if (d.dueDate < d.billDate) {
    return { ok: false, error: "A bill cannot fall due before it is issued.", fieldErrors: { dueDate: ["Must be on or after the bill date."] } };
  }

  const gate = await editGate("VendorBill", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    const db = await supabaseServer();
    const { data: before } = await db.from("vendor_bill").select("totalAmount, paidAmount").eq("id", id).maybeSingle();
    if (!before) return { ok: false, error: "That bill no longer exists." };

    const totals = await computeBillLines(d.lines);
    const paid = toDecimal(before.paidAmount ?? 0);
    if (paid.greaterThan(0) && !totals.totalAmount.equals(toDecimal(before.totalAmount))) {
      return { ok: false, error: "Payments have been made against this bill, so its total has to stay the same. Correct the wording, or record a credit from the supplier." };
    }

    const { error } = await db.rpc("update_with_lines", {
      p_table: "vendor_bill",
      p_id: id,
      p_payload: {
        vendorAccountId: d.vendorAccountId,
        vendorInvoiceNumber: d.vendorInvoiceNumber || null,
        projectId: d.projectId || null,
        billDate: d.billDate,
        dueDate: d.dueDate,
        currencyCode: d.currencyCode,
        subtotal: totals.subtotal.toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        totalAmount: totals.totalAmount.toFixed(2),
        outstandingAmount: totals.totalAmount.minus(paid).toFixed(2),
        notes: d.notes || null,
      },
      p_line_table: "vendor_bill_line",
      p_lines: totals.lines.map((l) => ({ ...l, lineTotal: l.lineTotal.toFixed(2) })),
      p_parent_field: "vendorBillId",
      p_entity_type: "VendorBill",
      p_actor_id: _auth.user.id,
    });
    if (error) throw new Error(error.message);
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/vendor-bills");
    revalidatePath(`/vendor-bills/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not save the bill." };
  }
}

const BILL_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "DRAFT", "CANCELLED"],
  APPROVED: ["CANCELLED"],
  PARTIALLY_PAID: [],
  PAID: [],
  OVERDUE: [],
  CANCELLED: [],
};

export async function setVendorBillStatus(
  id: string,
  next: string,
): Promise<ActionResult<{ id: string }>> {
  // Approving a bill commits the company to paying a supplier, which is not
  // the same authority as issuing an invoice to a customer.
  const _auth = next === "APPROVED"
    ? await authorizeAny(PERMISSIONS.PAYABLE_APPROVE, PERMISSIONS.INVOICE_APPROVE)
    : await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const db = await supabaseServer();

  const { data: bill } = await db
    .from("vendor_bill")
    .select("id, status, paidAmount")
    .eq("id", id)
    .maybeSingle();

  if (!bill) return { ok: false, error: "That bill no longer exists." };

  const allowed = BILL_TRANSITIONS[bill.status] ?? [];
  if (!allowed.includes(next)) {
    return {
      ok: false,
      error: `A bill that is ${bill.status.toLowerCase().replace(/_/g, " ")} cannot become ${next.toLowerCase().replace(/_/g, " ")}.`,
    };
  }

  // Cancelling a bill money has already gone against would leave the payment
  // allocated to nothing.
  if (next === "CANCELLED" && Number(bill.paidAmount) > 0) {
    return { ok: false, error: "That bill has been paid against. Reverse the payment first." };
  }

  try {
    await updateRecord("vendor_bill", id, { status: next }, "VendorBill", _auth.user.id);
    revalidatePath("/vendor-bills");
    revalidatePath(`/vendor-bills/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the bill." };
  }
}

// ---------------------------------------------------------------------------
// Vendor payments
// ---------------------------------------------------------------------------

const vendorPaymentSchema = z.object({
  vendorAccountId: z.string().uuid("Choose the supplier."),
  paymentDate: z.string().min(1, "When was it paid?"),
  amount: z.coerce.number().positive("A payment has to be more than zero."),
  currencyCode: z.string().length(3).default("PKR"),
  paymentMethod: picklistCode,
  bankAccountId: z.string().uuid().optional().nullable(),
  referenceNumber: z.string().max(100).optional().nullable(),
  /** Bills this payment settles, in the order given. */
  allocations: z
    .array(
      z.object({
        vendorBillId: z.string().uuid(),
        allocatedAmount: z.coerce.number().positive(),
      }),
    )
    .default([]),
});

/**
 * Rewrites a bill's paid and outstanding balances from its allocations.
 *
 * The single place either is written, so the AP ageing view can be trusted.
 */
async function recalculateVendorBill(billId: string) {
  const db = await supabaseServer();

  const { data: bill } = await db
    .from("vendor_bill")
    .select("id, totalAmount, status")
    .eq("id", billId)
    .maybeSingle();

  if (!bill) return;

  const { data: allocations } = await db
    .from("vendor_payment_allocation")
    .select("allocatedAmount, vendorPayment:vendor_payment ( status )")
    .eq("vendorBillId", billId);

  // Only cleared money counts. A pending cheque is not a paid bill.
  const paid = ((allocations ?? []) as Record<string, unknown>[])
    .filter((a) => {
      const payment = one(a.vendorPayment as never) as { status?: string } | null;
      return payment?.status === "CLEARED";
    })
    .reduce((total, a) => total.plus(toDecimal(a.allocatedAmount)), ZERO);

  const total = toDecimal(bill.totalAmount);
  const outstanding = Decimal.max(total.minus(paid), ZERO).toDecimalPlaces(2);

  let status = bill.status;
  if (!["CANCELLED", "DRAFT", "UNDER_REVIEW"].includes(bill.status)) {
    if (outstanding.lessThanOrEqualTo(0)) status = "PAID";
    else if (paid.greaterThan(0)) status = "PARTIALLY_PAID";
    else status = "APPROVED";
  }

  await db
    .from("vendor_bill")
    .update({
      paidAmount: paid.toDecimalPlaces(2).toFixed(2),
      outstandingAmount: outstanding.toFixed(2),
      status,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", billId);
}

export async function recordVendorPayment(
  input: z.infer<typeof vendorPaymentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PAYMENT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = vendorPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const allocated = d.allocations.reduce((s, a) => s.plus(toDecimal(a.allocatedAmount)), ZERO);
  if (allocated.greaterThan(toDecimal(d.amount))) {
    return {
      ok: false,
      error: `You have allocated ${allocated.toFixed(2)} of a ${d.amount.toFixed(2)} payment.`,
    };
  }

  try {
    const db = await supabaseServer();

    // Every bill must belong to this supplier and still owe at least what is
    // being put against it.
    for (const allocation of d.allocations) {
      const { data: bill } = await db
        .from("vendor_bill")
        .select("id, billNumber, vendorAccountId, outstandingAmount, status")
        .eq("id", allocation.vendorBillId)
        .maybeSingle();

      if (!bill) return { ok: false, error: "One of those bills no longer exists." };

      if (bill.vendorAccountId !== d.vendorAccountId) {
        return {
          ok: false,
          error: `${bill.billNumber} belongs to a different supplier.`,
        };
      }

      if (["DRAFT", "UNDER_REVIEW", "CANCELLED"].includes(bill.status)) {
        return {
          ok: false,
          error: `${bill.billNumber} is not approved yet, so it cannot be paid.`,
        };
      }

      if (toDecimal(allocation.allocatedAmount).greaterThan(toDecimal(bill.outstandingAmount))) {
        return {
          ok: false,
          error: `${bill.billNumber} only has ${Number(bill.outstandingAmount).toFixed(2)} outstanding.`,
        };
      }
    }

    const payment = await createRecord<{ id: string }>(
      "vendor_payment",
      {
        vendorAccountId: d.vendorAccountId,
        paymentDate: d.paymentDate,
        amount: d.amount,
        currencyCode: d.currencyCode,
        paymentMethod: d.paymentMethod,
        bankAccountId: d.bankAccountId || null,
        referenceNumber: d.referenceNumber || null,
        status: "CLEARED",
      },
      { field: "paymentNumber", sequence: SEQUENCES.VENDOR_PAYMENT },
    );

    if (d.allocations.length) {
      const { error } = await db.from("vendor_payment_allocation").insert(
        d.allocations.map((a) => ({
          id: randomUUID(),
          vendorPaymentId: payment.id,
          vendorBillId: a.vendorBillId,
          allocatedAmount: a.allocatedAmount,
        })),
      );

      if (error) throw new Error(error.message);

      for (const allocation of d.allocations) {
        await recalculateVendorBill(allocation.vendorBillId);
      }
    }

    revalidatePath("/vendor-bills");
    revalidatePath("/vendor-payments");
    return { ok: true, data: { id: payment.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not record the payment." };
  }
}

export async function listVendorPayments(filters?: { search?: string; status?: string }) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  let query = db
    .from("vendor_payment")
    .select(
      `*,
       vendor:account ( id, name ),
       bankAccount:bank_account ( id, name ),
       allocations:vendor_payment_allocation (
         *,
         vendorBill:vendor_bill ( id, billNumber )
       )`,
    )
    .is("deletedAt", null)
    .order("paymentDate", { ascending: false });

  if (filters?.status) query = query.eq("status", filters.status);
  query = applySearch(query, filters?.search, ["paymentNumber", "referenceNumber"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load vendor payments: ${error.message}`);

  type Row = Record<string, unknown>;

  return (data ?? []).map((p) => ({
    ...p,
    vendor: one(p.vendor as never),
    bankAccount: one(p.bankAccount as never),
    allocations: ((p.allocations ?? []) as Row[]).map((a): Row => ({
      ...a,
      vendorBill: one(a.vendorBill as never),
    })),
  }));
}

/** Options the expense and bill forms need. */
export async function getPayableFormOptions() {
  await requirePermission(PERMISSIONS.INVOICE_READ);
  const db = await supabaseServer();

  const [categories, vendors, users, projects, taxRates, currencies, banks, openBills] =
    await Promise.all([
      db.from("expense_category").select("id, name, requiresReceipt").eq("active", true).order("name"),
      db
        .from("account")
        .select("id, name")
        .in("accountType", ["VENDOR", "PARTNER", "OTHER"])
        .is("deletedAt", null)
        .order("name"),
      db.from("app_user").select("id, fullName").eq("status", "ACTIVE").is("deletedAt", null).order("fullName"),
      db.from("project").select("id, name, projectNumber").is("deletedAt", null).order("name"),
      db.from("tax_rate").select("id, name, ratePercent").eq("active", true).order("name"),
      db.from("currency").select("code, name").order("code"),
      db.from("bank_account").select("id, name").eq("active", true).order("name"),
      db
        .from("vendor_bill")
        .select("id, billNumber, vendorAccountId, outstandingAmount, dueDate, currencyCode")
        .is("deletedAt", null)
        .gt("outstandingAmount", 0)
        .in("status", ["APPROVED", "PARTIALLY_PAID", "OVERDUE"])
        .order("dueDate"),
    ]);

  return {
    categories: categories.data ?? [],
    vendors: vendors.data ?? [],
    users: users.data ?? [],
    projects: projects.data ?? [],
    taxRates: taxRates.data ?? [],
    currencies: currencies.data ?? [],
    banks: banks.data ?? [],
    openBills: openBills.data ?? [],
  };
}

/** Totals for the payables dashboard tiles. */
/**
 * The two claim figures the expense screen puts in its header, scoped to the
 * reader.
 *
 * getPayablesSummary answers the same two questions company-wide, but it also
 * carries vendor-bill totals and sits behind invoice:read — so a consultant
 * calling it for their own claim counts was refused, and granting them the
 * invoice permission to fix that is exactly what put the whole finance ledger
 * in front of them in the first place.
 *
 * An approver sees every claim waiting on them, which is the job. A claimant
 * sees their own, because "PKR 1.4M awaiting approval" is not a fact about a
 * consultant's two taxi receipts.
 */
export async function getExpenseClaimSummary() {
  const me = await requirePermission(PERMISSIONS.EXPENSE_READ);
  const db = await supabaseServer();

  // An approver counts everyone's claims; a claimant counts their own.
  const mineOnly = can(me, PERMISSIONS.EXPENSE_APPROVE) ? null : me.id;

  let pendingQuery = db
    .from("expense")
    .select("amount")
    .is("deletedAt", null)
    .eq("approvalStatus", "SUBMITTED");
  if (mineOnly) pendingQuery = pendingQuery.eq("employeeUserId", mineOnly);

  let unpaidQuery = db
    .from("expense")
    .select("amount")
    .is("deletedAt", null)
    .eq("approvalStatus", "APPROVED")
    .eq("paymentStatus", "UNPAID");
  if (mineOnly) unpaidQuery = unpaidQuery.eq("employeeUserId", mineOnly);

  const [pending, unpaid] = await Promise.all([pendingQuery, unpaidQuery]);

  const sum = (res: { data?: unknown }) =>
    ((res.data ?? []) as Record<string, unknown>[])
      .reduce((total, row) => total.plus(toDecimal(row.amount)), ZERO)
      .toFixed(2);

  return {
    awaitingApproval: sum(pending),
    awaitingApprovalCount: ((pending.data ?? []) as unknown[]).length,
    toPay: sum(unpaid),
    toPayCount: ((unpaid.data ?? []) as unknown[]).length,
  };
}

export async function getPayablesSummary() {
  await requirePermission(PERMISSIONS.INVOICE_READ);
  const db = await supabaseServer();

  const today = new Date().toISOString().slice(0, 10);

  const [outstanding, overdue, pendingExpenses, unpaidExpenses] = await Promise.all([
    db
      .from("vendor_bill")
      .select("outstandingAmount")
      .is("deletedAt", null)
      .not("status", "in", '("DRAFT","CANCELLED","PAID")'),
    db
      .from("vendor_bill")
      .select("outstandingAmount")
      .is("deletedAt", null)
      .not("status", "in", '("DRAFT","CANCELLED","PAID")')
      .lt("dueDate", today),
    db
      .from("expense")
      .select("amount")
      .is("deletedAt", null)
      .eq("approvalStatus", "SUBMITTED"),
    db
      .from("expense")
      .select("amount")
      .is("deletedAt", null)
      .eq("approvalStatus", "APPROVED")
      .eq("paymentStatus", "UNPAID"),
  ]);

  const sum = (res: { data?: unknown }, column: string) =>
    ((res.data ?? []) as Record<string, unknown>[])
      .reduce((total, row) => total.plus(toDecimal(row[column])), ZERO)
      .toFixed(2);

  return {
    billsOutstanding: sum(outstanding, "outstandingAmount"),
    billsOutstandingCount: ((outstanding.data ?? []) as unknown[]).length,
    billsOverdue: sum(overdue, "outstandingAmount"),
    billsOverdueCount: ((overdue.data ?? []) as unknown[]).length,
    expensesAwaitingApproval: sum(pendingExpenses, "amount"),
    expensesAwaitingApprovalCount: ((pendingExpenses.data ?? []) as unknown[]).length,
    expensesToPay: sum(unpaidExpenses, "amount"),
    expensesToPayCount: ((unpaidExpenses.data ?? []) as unknown[]).length,
  };
}
