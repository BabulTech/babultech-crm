"use server";

import { commercialPlanSchema } from "@/lib/product-plans";
import { describeInvalid } from "@/lib/form-errors";
import { withRateSnapshots } from "@/lib/rate-snapshots";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { picklistCode } from "@/lib/picklists";
import Decimal from "decimal.js";
import { toDecimal, one } from "@/lib/decimal";
import { supabaseServer } from "@/lib/supabase";
import { listCatalogueProducts } from "./price-books";
import { createRecord, updateRecord, LIST_LIMIT, applySearch } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, authorizeAny, requirePermission } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import type { ActionResult } from "./partners";

/**
 * Billing: invoices, billing runs and cash application (spec §10.5, §11).
 *
 * Two balances are maintained by this module and never edited by hand:
 *   paidAmount        = sum of the invoice's payment allocations
 *   outstandingAmount = totalAmount - paidAmount - writeOffAmount
 *
 * `recalculateInvoice` is the single place either is written, so the AR ageing
 * view can be trusted. The database's `payment_allocation_check` trigger is the
 * backstop that stops allocations exceeding the payment.
 */

const ZERO = toDecimal(0);
const EDITABLE_INVOICE = ["DRAFT", "APPROVED"] as const;

const lineSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  productPlan: commercialPlanSchema.optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  milestoneId: z.string().uuid().optional().nullable(),
  description: z.string().min(1, "Every line needs a description."),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  discountPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  taxRateId: z.string().uuid().optional().nullable(),
});

const invoiceSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  contractId: z.string().uuid().optional().nullable(),
  milestoneId: z.string().uuid().optional().nullable(),
  invoiceDate: z.coerce.date(),
  dueDate: z.coerce.date(),
  currencyCode: z.string().length(3).default("PKR"),
  paymentTermsDays: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1, "An invoice needs at least one line."),
});

async function computeLines(lines: z.infer<typeof lineSchema>[]) {
  const db = await supabaseServer();
  const taxRateIds = [...new Set(lines.map((l) => l.taxRateId).filter(Boolean))] as string[];
  const taxRates = taxRateIds.length
    ? (await db.from("tax_rate").select("id, ratePercent").in("id", taxRateIds)).data ?? []
    : [];
  const rateOf = (id: string | null | undefined) =>
    toDecimal(taxRates.find((t) => t.id === id)?.ratePercent ?? 0);

  let subtotal = ZERO;
  let discountAmount = ZERO;
  let taxAmount = ZERO;

  const computed = lines.map((line) => {
    const gross = toDecimal(line.quantity).times(line.unitPrice);
    const discount = gross.times(line.discountPercent ?? 0).dividedBy(100);
    const net = gross.minus(discount).toDecimalPlaces(2);
    const tax = net.times(rateOf(line.taxRateId)).dividedBy(100).toDecimalPlaces(2);

    subtotal = subtotal.plus(gross);
    discountAmount = discountAmount.plus(discount);
    taxAmount = taxAmount.plus(tax);

    return {
      productId: line.productId ?? null,
      productPlan: line.productPlan ?? null,
      projectId: line.projectId ?? null,
      milestoneId: line.milestoneId ?? null,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent ?? null,
      taxRateId: line.taxRateId ?? null,
      lineTotal: net,
    };
  });

  subtotal = subtotal.toDecimalPlaces(2);
  discountAmount = discountAmount.toDecimalPlaces(2);
  taxAmount = taxAmount.toDecimalPlaces(2);

  return {
    lines: computed,
    subtotal,
    discountAmount,
    taxAmount,
    totalAmount: subtotal.minus(discountAmount).plus(taxAmount).toDecimalPlaces(2),
  };
}

/**
 * Recomputes paidAmount, outstandingAmount and status from the allocations.
 * Every mutation that can move an invoice's balance ends by calling this.
 */
async function recalculateInvoice(invoiceId: string) {
  const db = await supabaseServer();

  // Locks the invoice, sums only CLEARED allocations, rewrites both balances
  // and advances the status — atomically. See
  // supabase/functions-sql/021_fn_recalculate_invoice.sql. This is the single place
  // paidAmount and outstandingAmount are ever written, which is what makes the
  // AR ageing view trustworthy.
  const { data, error } = await db.rpc("recalculate_invoice", {
    p_invoice_id: invoiceId,
  });

  if (error) throw new Error(error.message);
  return data as { paid: number; outstanding: number; status: string };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export async function createInvoice(
  input: z.infer<typeof invoiceSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = invoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.dueDate < data.invoiceDate) {
    return {
      ok: false,
      error: "An invoice cannot fall due before it is issued.",
      fieldErrors: { dueDate: ["Must be on or after the invoice date."] },
    };
  }

  try {
    const totals = await computeLines(data.lines);
    const db = await supabaseServer();

    // Invoice + its lines in one transaction: an invoice with a total but no
    // lines looks payable and reconciles against nothing.
    const { data: invoice, error } = await db.rpc("create_with_lines", {
      p_table: "invoice",
      p_payload: {
        accountId: data.accountId,
        contactId: data.contactId ?? null,
        projectId: data.projectId ?? null,
        contractId: data.contractId ?? null,
        milestoneId: data.milestoneId ?? null,
        invoiceDate: data.invoiceDate.toISOString().slice(0, 10),
        dueDate: data.dueDate.toISOString().slice(0, 10),
        status: "DRAFT",
        currencyCode: data.currencyCode,
        subtotal: totals.subtotal.toFixed(2),
        discountAmount: totals.discountAmount.toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        totalAmount: totals.totalAmount.toFixed(2),
        paidAmount: "0.00",
        outstandingAmount: totals.totalAmount.toFixed(2),
        paymentTermsDays: data.paymentTermsDays ?? null,
        notes: data.notes ?? null,
      },
      p_line_table: "invoice_line",
      p_lines: totals.lines.map((l) => ({ ...l, lineTotal: l.lineTotal.toFixed(2) })),
      p_parent_field: "invoiceId",
      p_number_field: "invoiceNumber",
      p_sequence: SEQUENCES.INVOICE,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/invoices");
    return { ok: true, data: { id: invoice.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the invoice." };
  }
}

export async function updateInvoice(
  id: string,
  input: z.infer<typeof invoiceSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = invoiceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("invoice")
      .select("status, invoiceNumber, paidAmount, writeOffAmount")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That invoice no longer exists." };

    if (!(EDITABLE_INVOICE as readonly string[]).includes(before.status)) {
      return {
        ok: false,
        error: `${before.invoiceNumber} has been sent to the customer. Issue a credit note or write it off - a sent invoice is not editable.`,
      };
    }

    const totals = await computeLines(data.lines);

    // Replaces the lines and updates the header in one transaction: a delete
    // that lands without the re-insert leaves an invoice with no body.
    const { error } = await db.rpc("update_with_lines", {
      p_table: "invoice",
      p_id: id,
      p_payload: {
        contactId: data.contactId ?? null,
        projectId: data.projectId ?? null,
        contractId: data.contractId ?? null,
        milestoneId: data.milestoneId ?? null,
        invoiceDate: data.invoiceDate.toISOString().slice(0, 10),
        dueDate: data.dueDate.toISOString().slice(0, 10),
        currencyCode: data.currencyCode,
        subtotal: totals.subtotal.toFixed(2),
        discountAmount: totals.discountAmount.toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        totalAmount: totals.totalAmount.toFixed(2),
        outstandingAmount: totals.totalAmount
          .minus(toDecimal(before.paidAmount))
          .minus(toDecimal(before.writeOffAmount))
          .toFixed(2),
        paymentTermsDays: data.paymentTermsDays ?? null,
        notes: data.notes ?? null,
      },
      p_line_table: "invoice_line",
      p_lines: totals.lines.map((l) => ({ ...l, lineTotal: l.lineTotal.toFixed(2) })),
      p_parent_field: "invoiceId",
      p_entity_type: "Invoice",
      p_actor_id: user.id,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the invoice." };
  }
}

/**
 * Issues the invoice. Also stamps the milestone as invoiced so a milestone can
 * never be billed twice (spec §13).
 */
export async function sendInvoice(id: string): Promise<ActionResult> {
  // Asking a customer for money. Separate from forgiving what they owe.
  const _auth = await authorizeAny(PERMISSIONS.INVOICE_ISSUE, PERMISSIONS.INVOICE_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("invoice")
      .select(
        "status, invoiceNumber, milestoneId, preparedById, lines:invoice_line ( id ), milestone ( name, invoicedAt )",
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That invoice no longer exists." };

    if (!(EDITABLE_INVOICE as readonly string[]).includes(before.status)) {
      return { ok: false, error: `${before.invoiceNumber} has already been issued.` };
    }
    if (((before.lines ?? []) as unknown[]).length === 0) {
      return { ok: false, error: "An invoice with no lines cannot be sent." };
    }
    // The database refuses this too (guard_invoice_issue), but reaching it
    // costs a write that fails; saying so here is the better answer.
    if (before.preparedById && before.preparedById === user.id) {
      return {
        ok: false,
        error: `${before.invoiceNumber} was prepared by you. Someone else has to issue it.`,
      };
    }

    const milestone = one(before.milestone as never) as
      | { name: string; invoicedAt: string | null }
      | null;

    if (milestone?.invoicedAt) {
      // A milestone billed twice is money invoiced twice (spec §13), so this
      // check guards the stamp below.
      return {
        ok: false,
        error: `Milestone "${milestone.name}" was already invoiced on ${new Date(
          milestone.invoicedAt,
        ).toLocaleDateString("en-GB")}.`,
      };
    }

    await updateRecord(
      "invoice",
      id,
      { status: "SENT", sentAt: new Date().toISOString() },
      "Invoice",
      user.id,
    );

    if (before.milestoneId) {
      await db
        .from("milestone")
        .update({
          invoicedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .eq("id", before.milestoneId);
    }

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not send the invoice." };
  }
}

export async function writeOffInvoice(id: string, amount: number, reason: string): Promise<ActionResult> {
  // Forgiving money already invoiced. Separate from issuing it.
  const _auth = await authorizeAny(PERMISSIONS.INVOICE_VOID, PERMISSIONS.INVOICE_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  if (!reason.trim()) return { ok: false, error: "A write-off needs a reason." };
  if (!(amount > 0)) return { ok: false, error: "Enter the amount being written off." };

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("invoice")
      .select("outstandingAmount, writeOffAmount, notes")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That invoice no longer exists." };

    const writeOff = toDecimal(amount);

    if (writeOff.greaterThan(toDecimal(before.outstandingAmount).plus(0.005))) {
      return {
        ok: false,
        error: `You cannot write off more than the ${before.outstandingAmount} still outstanding.`,
      };
    }

    await updateRecord(
      "invoice",
      id,
      {
        writeOffAmount: toDecimal(before.writeOffAmount).plus(writeOff).toFixed(2),
        notes: `${before.notes ?? ""}\n\n[Written off ${writeOff.toString()} by ${user.fullName}: ${reason.trim()}]`.trim(),
      },
      "Invoice",
      user.id,
    );

    // Balances and status are rewritten from the allocations, never by hand.
    await recalculateInvoice(id);

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not write the invoice off." };
  }
}

/**
 * Milestone billing run. Finds every completed, billing-triggering milestone
 * that has not yet been invoiced and raises a draft invoice for each.
 */
export async function runMilestoneBilling(
  projectId?: string,
): Promise<ActionResult<{ created: number; skipped: string[] }>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    const db = await supabaseServer();

    let dueQuery = db
      .from("milestone")
      .select(
        `id, name, billingAmount, billingPercent,
         invoices:invoice ( id, status, deletedAt ),
         project!inner ( id, name, projectType, accountId, contractId, contractValue, currencyCode, deletedAt )`,
      )
      .eq("billingTrigger", true)
      .eq("status", "COMPLETED")
      .is("invoicedAt", null)
      .is("project.deletedAt", null)
      // Internal work has no customer to invoice. Its milestones can be marked
      // as billing triggers like any other, so the run has to exclude it here
      // rather than trust that nobody ticked the box.
      .eq("project.projectType", "CUSTOMER");

    if (projectId) dueQuery = dueQuery.eq("projectId", projectId);

    const { data: candidates, error: dueError } = await dueQuery;
    if (dueError) throw new Error(dueError.message);

    // `invoicedAt` is only stamped when an invoice is *issued*, so on its own it
    // would let a second run raise a duplicate draft for the same milestone.
    // PostgREST has no not-exists filter on a relation, so the live-invoice
    // check is applied here — without it the run is not safe to re-run.
    const due = (candidates ?? [])
      .map((m) => ({ ...m, project: one(m.project as never) as unknown as Record<string, unknown> }))
      .filter((m) => {
        const live = ((m.invoices ?? []) as { status: string; deletedAt: string | null }[])
          .filter((i) => !i.deletedAt && i.status !== "CANCELLED");
        return live.length === 0;
      });

    const skipped: string[] = [];
    let created = 0;

    for (const milestone of due) {
      const contractValue = toDecimal(milestone.project.contractValue ?? 0);
      const amount = milestone.billingAmount
        ? toDecimal(milestone.billingAmount)
        : contractValue.times(milestone.billingPercent ?? 0).dividedBy(100);

      if (amount.lessThanOrEqualTo(0)) {
        skipped.push(`${milestone.name} - no billable amount could be worked out`);
        continue;
      }

      const { error: createError } = await db.rpc("create_with_lines", {
        p_table: "invoice",
        p_payload: {
          accountId: milestone.project.accountId,
          projectId: milestone.project.id,
          contractId: milestone.project.contractId,
          milestoneId: milestone.id,
          invoiceDate: new Date().toISOString().slice(0, 10),
          dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
          status: "DRAFT",
          currencyCode: milestone.project.currencyCode,
          subtotal: amount.toFixed(2),
          discountAmount: "0.00",
          taxAmount: "0.00",
          totalAmount: amount.toFixed(2),
          paidAmount: "0.00",
          outstandingAmount: amount.toFixed(2),
          paymentTermsDays: 30,
          notes: `Milestone billing, ${milestone.name} (${milestone.project.name}).`,
        },
        p_line_table: "invoice_line",
        p_lines: [
          {
            description: `${milestone.project.name}, ${milestone.name}`,
            projectId: milestone.project.id,
            milestoneId: milestone.id,
            quantity: 1,
            unitPrice: amount.toFixed(2),
            lineTotal: amount.toFixed(2),
          },
        ],
        p_parent_field: "invoiceId",
        p_number_field: "invoiceNumber",
        p_sequence: SEQUENCES.INVOICE,
      });

      if (createError) throw new Error(createError.message);
      created += 1;
    }

    revalidatePath("/invoices");
    return { ok: true, data: { created, skipped } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The billing run failed." };
  }
}

/**
 * Time-and-materials billing run: turns approved, billable, un-invoiced time
 * into invoice lines grouped by person and rate.
 */
export async function runTimeBilling(
  projectId: string,
): Promise<ActionResult<{ id: string; hours: number } | null>> {
  const _auth = await authorize(PERMISSIONS.INVOICE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    const db = await supabaseServer();

    const { data: logRows } = await db
      .from("time_log")
      .select("id, userId, hours, user:app_user!time_log_userId_fkey ( id, fullName )")
      .eq("projectId", projectId)
      .eq("approvalStatus", "APPROVED")
      .eq("billable", true)
      .is("invoiceLineId", null);

    const logs = (await withRateSnapshots("time_log", logRows ?? [], "billing")).filter((l) => l.billingRate !== null).map((l) => ({
      ...l,
      user: one(l.user as never) as unknown as { id: string; fullName: string },
    }));

    if (logs.length === 0) {
      return { ok: false, error: "No approved, billable, un-invoiced time on this project." };
    }

    const { data: project } = await db
      .from("project")
      .select("id, name, projectType, accountId, contractId, currencyCode")
      .eq("id", projectId)
      .maybeSingle();

    if (!project) return { ok: false, error: "That project no longer exists." };

    // Internal work is booked and costed like any other project, so it can hold
    // approved billable time. There is nobody to send it to, and an invoice
    // without an account is not a document anyone can chase.
    if (project.projectType === "INTERNAL") {
      return {
        ok: false,
        error: "This is internal work, so it cannot be invoiced - there is no customer to bill.",
      };
    }

    // One line per person per rate — the way a T&M invoice actually reads.
    const groups = new Map<string, { name: string; rate: Decimal; hours: Decimal; ids: string[] }>();
    for (const log of logs) {
      const rate = toDecimal(log.billingRate!);
      const key = `${log.userId}:${rate.toString()}`;
      const group = groups.get(key) ?? { name: log.user?.fullName ?? "Unknown", rate, hours: ZERO, ids: [] };
      group.hours = group.hours.plus(log.hours);
      group.ids.push(log.id);
      groups.set(key, group);
    }

    let subtotal = ZERO;
    const groupPayload = [...groups.values()].map((g) => {
      const lineTotal = g.hours.times(g.rate).toDecimalPlaces(2);
      subtotal = subtotal.plus(lineTotal);
      return {
        description: `${g.name}, ${g.hours.toString()} hours @ ${g.rate.toString()}`,
        hours: g.hours.toString(),
        rate: g.rate.toString(),
        lineTotal: lineTotal.toFixed(2),
        logIds: g.ids,
      };
    });

    // Invoice, lines, and the invoiceLineId stamps on the time logs, all in one
    // transaction. If the invoice landed but the stamps did not, the next run
    // would bill the same hours again — the customer charged twice for the
    // same work. See supabase/functions-sql/028_fn_time_billing.sql.
    const { data: invoice, error } = await db.rpc("run_time_billing", {
      p_project_id: project.id,
      p_account_id: project.accountId,
      p_contract_id: project.contractId,
      p_currency: project.currencyCode,
      p_notes: `Time and materials, ${project.name}.`,
      p_subtotal: subtotal.toFixed(2),
      p_groups: groupPayload,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/invoices");
    revalidatePath(`/projects/${projectId}`);
    const hours = logs.reduce((s, l) => s + Number(l.hours), 0);
    return { ok: true, data: { id: invoice.id, hours } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The billing run failed." };
  }
}

// ---------------------------------------------------------------------------
// Payments and cash application
// ---------------------------------------------------------------------------

const paymentSchema = z.object({
  accountId: z.string().uuid(),
  paymentDate: z.coerce.date(),
  amount: z.coerce.number().positive(),
  currencyCode: z.string().length(3).default("PKR"),
  paymentMethod: picklistCode,
  referenceNumber: z.string().max(100).optional().nullable(),
  status: z.enum(["PENDING", "CLEARED"]).default("CLEARED"),
  notes: z.string().optional().nullable(),
  /** Optional same-transaction application against specific invoices. */
  allocations: z
    .array(z.object({ invoiceId: z.string().uuid(), amount: z.coerce.number().positive() }))
    .optional(),
});

export async function recordPayment(
  input: z.infer<typeof paymentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PAYMENT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = paymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const allocations = data.allocations ?? [];
  const allocatedTotal = allocations.reduce((s, a) => s + a.amount, 0);
  if (allocatedTotal > data.amount + 0.005) {
    return {
      ok: false,
      error: `You have applied ${allocatedTotal} against a payment of ${data.amount}.`,
    };
  }

  try {
    const db = await supabaseServer();

    // Payment, its allocations, and the recalculation of every touched invoice
    // in one transaction. A refused allocation rolls the payment row back too —
    // otherwise cash would be recorded against nothing. See
    // supabase/functions-sql/022_fn_record_payment.sql.
    const { data: payment, error } = await db.rpc("record_payment", {
      p_payload: {
        accountId: data.accountId,
        paymentDate: data.paymentDate.toISOString().slice(0, 10),
        amount: data.amount,
        unallocatedAmount: toDecimal(data.amount).minus(allocatedTotal).toFixed(2),
        currencyCode: data.currencyCode,
        paymentMethod: data.paymentMethod,
        referenceNumber: data.referenceNumber ?? null,
        status: data.status,
        clearedAt: data.status === "CLEARED" ? new Date().toISOString() : null,
        notes: data.notes ?? null,
      },
      p_allocations: allocations.map((a) => ({
        invoiceId: a.invoiceId,
        amount: a.amount,
      })),
      p_actor_id: user.id,
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath("/invoices");
    revalidatePath("/payments");
    return { ok: true, data: { id: payment.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not record the payment." };
  }
}

/** Applies unallocated cash from an existing payment against an invoice. */
export async function allocatePayment(
  paymentId: string,
  invoiceId: string,
  amount: number,
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.PAYMENT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;
  if (!(amount > 0)) return { ok: false, error: "Enter an amount to apply." };

  try {
    const db = await supabaseServer();

    // Unapplied-cash and overpay checks run inside the function, under locks on
    // both the payment and the invoice: checking here and writing separately is
    // a race that lets two concurrent allocations jointly overpay.
    const { error } = await db.rpc("allocate_payment", {
      p_payment_id: paymentId,
      p_invoice_id: invoiceId,
      p_amount: amount,
      p_actor_id: user.id,
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath("/invoices");
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/payments");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not apply the payment." };
  }
}

export async function listPayments(filters?: {
  accountId?: string;
  unappliedOnly?: boolean;
  search?: string;
  status?: string;
}) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  let query = db
    .from("payment")
    .select(
      `*,
       account ( id, name ),
       allocations:payment_allocation ( *, invoice ( id, invoiceNumber ) )`,
    )
    .is("deletedAt", null)
    .order("paymentDate", { ascending: false });

  if (filters?.accountId) query = query.eq("accountId", filters.accountId);
  if (filters?.unappliedOnly) query = query.gt("unallocatedAmount", 0);
  if (filters?.status) query = query.eq("status", filters.status);
  query = applySearch(query, filters?.search, ["paymentNumber", "referenceNumber"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load payments: ${error.message}`);

  type Row = Record<string, unknown>;

  return (data ?? []).map((p) => ({
    ...p,
    account: one(p.account as never),
    allocations: ((p.allocations ?? []) as Row[]).map((a): Row => ({
      ...a,
      invoice: one(a.invoice as never),
    })),
  }));
}

export async function getInvoice(id: string) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("invoice")
    .select("*, lines:invoice_line ( * )")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load invoice: ${error.message}`);
  if (!data) return null;

  // PostgREST cannot order an embedded relation inline.
  return {
    ...data,
    lines: ((data.lines ?? []) as Record<string, unknown>[]).sort(
      (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
    ),
  };
}

/** Open invoices for a customer, for the cash-application screen. */
export async function getOpenInvoices(accountId: string) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("invoice")
    .select(
      "id, invoiceNumber, invoiceDate, dueDate, totalAmount, outstandingAmount, currencyCode, status",
    )
    .eq("accountId", accountId)
    .is("deletedAt", null)
    .not("status", "in", '("DRAFT","CANCELLED","PAID","WRITTEN_OFF")')
    .gt("outstandingAmount", 0)
    .order("dueDate");

  if (error) throw new Error(`Could not load open invoices: ${error.message}`);
  return data ?? [];
}

export async function getBillingFormOptions() {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  const [accountsRes, contactsRes, projectsRes, contractsRes, productsRes, taxRatesRes, currenciesRes] =
    await Promise.all([
      db.from("account").select("id, name").is("deletedAt", null).order("name"),
      db
        .from("contact")
        .select("id, firstName, lastName, accountId")
        .is("deletedAt", null)
        .not("accountId", "is", null)
        .order("lastName"),
      db
        .from("project")
        .select(
          `id, name, projectNumber, accountId, contractId,
           milestones:milestone ( id, name, invoicedAt, status, billingTrigger )`,
        )
        .is("deletedAt", null)
        // An invoice is always raised against a customer, so internal projects
        // are not offered here - picking one could only produce a bill with no
        // account behind it.
        .eq("projectType", "CUSTOMER")
        .order("name"),
      db
        .from("contract")
        .select("id, contractNumber, name, accountId")
        .is("deletedAt", null)
        .order("contractNumber"),
      listCatalogueProducts(),
      db.from("tax_rate").select("id, name, ratePercent").eq("active", true).order("name"),
      db.from("currency").select("*").eq("active", true).order("code"),
    ]);

  const accounts = accountsRes.data ?? [];
  const contacts = contactsRes.data ?? [];
  // Prisma filtered the embedded milestones in the query; PostgREST returns
  // them all, so the billingTrigger filter is applied here.
  const projects = (projectsRes.data ?? []).map((p) => ({
    ...p,
    milestones: ((p.milestones ?? []) as Record<string, unknown>[]).filter(
      (m) => m.billingTrigger,
    ),
  }));
  const contracts = contractsRes.data ?? [];
  const products = productsRes;
  const taxRates = taxRatesRes.data ?? [];
  const currencies = currenciesRes.data ?? [];

  return { accounts, contacts, projects, contracts, products, taxRates, currencies };
}

export async function getPayment(id: string) {
  await requirePermission(PERMISSIONS.INVOICE_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("payment")
    .select(
      `*,
       account ( id, name, accountNumber ),
       bankAccount:bank_account ( id, name ),
       allocations:payment_allocation (
         *,
         invoice ( id, invoiceNumber, totalAmount, outstandingAmount, status, dueDate, currencyCode )
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load payment: ${error.message}`);
  if (!data) return null;

  type Row = Record<string, unknown>;

  return {
    ...data,
    account: one(data.account as never),
    bankAccount: one(data.bankAccount as never),
    allocations: ((data.allocations ?? []) as Row[]).map((a): Row => ({
      ...a,
      invoice: one(a.invoice as never),
    })),
  };
}

const paymentEditSchema = z.object({
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the date it was received."),
  paymentMethod: z.enum(["BANK", "CHEQUE", "CASH", "CARD", "WALLET"]),
  referenceNumber: z.string().trim().max(100).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  amount: z.coerce.number().positive("The amount must be more than nothing.").optional(),
});

/**
 * Correcting a payment. A pending one is edited by anyone who records
 * payments; once cleared, by an administrator correcting it with a reason. The
 * amount only changes while nothing is allocated from it, so the invoices it
 * settled still add up.
 */
export async function updatePayment(id: string, input: z.infer<typeof paymentEditSchema>): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PAYMENT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const parsed = paymentEditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the payment." };
  const d = parsed.data;

  const gate = await editGate("Payment", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  const db = await supabaseServer();
  const { data: before } = await db.from("payment").select("amount, unallocatedAmount").eq("id", id).is("deletedAt", null).maybeSingle();
  if (!before) return { ok: false, error: "That payment no longer exists." };
  const { count: allocations } = await db.from("payment_allocation").select("id", { count: "exact", head: true }).eq("paymentId", id);

  const patch: Record<string, unknown> = {
    paymentDate: d.paymentDate,
    paymentMethod: d.paymentMethod,
    referenceNumber: d.referenceNumber || null,
    notes: d.notes || null,
  };
  if (d.amount !== undefined && !toDecimal(d.amount).equals(toDecimal(before.amount))) {
    if ((allocations ?? 0) > 0) {
      return { ok: false, error: "This payment is allocated to invoices, so its amount has to stay the same. Remove the allocations first." };
    }
    patch.amount = d.amount.toFixed(2);
    patch.unallocatedAmount = d.amount.toFixed(2);
  }

  try {
    await updateRecord("payment", id, patch, "Payment", _auth.user.id);
    await markCorrectionSaved(gate.correctionId);
    revalidatePath("/payments");
    revalidatePath(`/payments/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not save the payment." };
  }
}
