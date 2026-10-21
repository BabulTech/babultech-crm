"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { one } from "@/lib/decimal";
import { supabaseServer } from "@/lib/supabase";
import { getOpportunityPricing, type OpportunityPricing } from "./opportunity-lines";
import { updateRecord } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { quoteInputSchema as quotationSchema, type PricedLineInput, type QuoteInput } from "@/lib/priced-input";
import type { ActionResult } from "./partners";

/**
 * Quotations (spec §10.2).
 *
 * A quote is a document you have sent a customer, so it is treated as
 * immutable once it leaves the building: editing a SENT quote is refused and
 * `reviseQuotation` supersedes it with a new version instead. That is also
 * what makes `quotation_one_accepted_per_opportunity` — the partial unique
 * index in prisma/sql — safe to rely on.
 *
 * A quote is priced exactly as its deal is: the same price book, the same four
 * costs, discount and tax on every line, the same arithmetic. Its lines start
 * as a copy of the deal's, every value editable, and accepting it puts them
 * back on the deal (20260928000003_quotes_priced_like_deals.sql). Totals -
 * each line's and the header's - are worked out by the database from the
 * lines, so nothing here computes or writes one.
 */

const EDITABLE = ["DRAFT", "UNDER_REVIEW", "APPROVED"] as const;

/**
 * The lines as they are stored. A line with no description of its own reads
 * as its product's name, because the description is what the customer sees.
 */
async function storedLines(lines: PricedLineInput[]) {
  const db = await supabaseServer();
  const ids = [...new Set(lines.map((l) => l.productId))];
  const { data: products } = await db.from("product").select("id, name").in("id", ids);
  const nameOf = new Map((products ?? []).map((p) => [p.id as string, p.name as string]));

  return lines.map((l) => ({
    productId: l.productId,
    priceBookEntryId: l.priceBookEntryId ?? null,
    description: l.description?.trim() || nameOf.get(l.productId) || "Item",
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    licenseCost: l.licenseCost,
    maintenanceCost: l.maintenanceCost,
    cloudCost: l.cloudCost,
    aiCost: l.aiCost,
    discountPercent: l.discountPercent,
    taxRateId: l.taxRateId || null,
  }));
}

export async function createQuotation(
  input: QuoteInput,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = quotationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;

  if (data.expiryDate < data.quoteDate) {
    return {
      ok: false,
      error: "A quote cannot expire before it is issued.",
      fieldErrors: { expiryDate: ["Must be on or after the quote date."] },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: opportunity, error: oppErr } = await db
      .from("opportunity")
      .select("accountId")
      .eq("id", data.opportunityId)
      .single();

    if (oppErr || !opportunity) return { ok: false, error: "Opportunity not found." };

    const { data: last } = await db
      .from("quotation")
      .select("versionNumber")
      .eq("opportunityId", data.opportunityId)
      .order("versionNumber", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Quote + lines atomically: a quote with a total but no lines is not a quote.
    const { data: quote, error } = await db.rpc("create_with_lines", {
      p_table: "quotation",
      p_payload: {
        opportunityId: data.opportunityId,
        accountId: opportunity.accountId,
        contactId: data.contactId ?? null,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        status: "DRAFT",
        quoteDate: data.quoteDate.toISOString().slice(0, 10),
        expiryDate: data.expiryDate.toISOString().slice(0, 10),
        currencyCode: data.currencyCode,
        priceBookId: data.priceBookId || null,
        paymentTerms: data.paymentTerms ?? null,
        notes: data.notes ?? null,
        termsAndConditions: data.termsAndConditions ?? null,
      },
      p_line_table: "quote_line",
      p_lines: await storedLines(data.lines),
      p_parent_field: "quotationId",
      p_number_field: "quoteNumber",
      p_sequence: SEQUENCES.QUOTATION,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/quotations");
    revalidatePath(`/opportunities/${data.opportunityId}`);
    return { ok: true, data: { id: quote.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the quote." };
  }
}

export async function updateQuotation(
  id: string,
  input: QuoteInput,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = quotationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;

  if (data.expiryDate < data.quoteDate) {
    return {
      ok: false,
      error: "A quote cannot expire before it is issued.",
      fieldErrors: { expiryDate: ["Must be on or after the quote date."] },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("quotation")
      .select("status, quoteNumber")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Quote not found." };

    if (!(EDITABLE as readonly string[]).includes(before.status)) {
      return {
        ok: false,
        error: `${before.quoteNumber} is ${before.status
          .toLowerCase()
          .replace("_", " ")} and the customer has seen it. Create a revision instead of editing it.`,
      };
    }

    // Replaces the lines and updates the header in one transaction: a delete
    // that lands without the re-insert would leave a quote with no body.
    const { error } = await db.rpc("update_with_lines", {
      p_table: "quotation",
      p_id: id,
      p_payload: {
        contactId: data.contactId ?? null,
        quoteDate: data.quoteDate.toISOString().slice(0, 10),
        expiryDate: data.expiryDate.toISOString().slice(0, 10),
        currencyCode: data.currencyCode,
        priceBookId: data.priceBookId || null,
        paymentTerms: data.paymentTerms ?? null,
        notes: data.notes ?? null,
        termsAndConditions: data.termsAndConditions ?? null,
      },
      p_line_table: "quote_line",
      p_lines: await storedLines(data.lines),
      p_parent_field: "quotationId",
      p_entity_type: "Quotation",
      p_actor_id: user.id,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/quotations");
    revalidatePath(`/quotations/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the quote." };
  }
}

/**
 * Supersedes a sent quote with a fresh draft copy at the next version number.
 * The original is marked REVISED rather than edited, so the trail of what the
 * customer was actually shown survives.
 */
export async function reviseQuotation(id: string): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    // Copy + supersede in one transaction — see supabase/functions-sql/023_fn_revise_quotation.sql.
    const { data: revision, error } = await db.rpc("revise_quotation", {
      p_id: id,
      p_actor_id: user.id,
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath("/quotations");
    return { ok: true, data: { id: revision.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not revise the quote." };
  }
}

/** DRAFT/APPROVED → SENT. Also nudges the deal to Quote Submitted. */
export async function sendQuotation(id: string): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("quotation")
      .select("status, quoteNumber, expiryDate, opportunityId, preparedByPartnerId, approvalStatus, lines:quote_line ( id )")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Quote not found." };

    const unapproved = partnerQuoteUnapproved(before);
    if (unapproved) return { ok: false, error: unapproved };
    if (before.approvalStatus !== "APPROVED") {
      const { data: reason } = await db.rpc("quotation_approval_reason", { p_id: id });
      if (reason) return { ok: false, error: `${before.quoteNumber} needs approval before it is sent. ${reason} Choose Send for approval.` };
    }

    if (!(EDITABLE as readonly string[]).includes(before.status)) {
      return { ok: false, error: before.quoteNumber + " has already been sent." };
    }
    if ((before.lines ?? []).length === 0) {
      return { ok: false, error: "A quote with no lines cannot be sent." };
    }
    // PostgREST returns dates as ISO strings — parse before comparing, or this
    // check is silently always false.
    if (new Date(before.expiryDate as string) < new Date()) {
      return {
        ok: false,
        error: "This quote's expiry date has already passed. Extend it before sending.",
      };
    }

    await updateRecord(
      "quotation",
      id,
      { status: "SENT", sentAt: new Date().toISOString() },
      "Quotation",
      user.id,
    );

    const { data: opp } = await db
      .from("opportunity")
      .select("stage")
      .eq("id", before.opportunityId)
      .maybeSingle();

    const earlyStages = ["DISCOVERY", "QUALIFICATION", "REQUIREMENTS", "SOLUTION_PROPOSED"];
    if (opp && earlyStages.includes(opp.stage)) {
      await updateRecord(
        "opportunity",
        before.opportunityId,
        { stage: "QUOTE_SUBMITTED", probabilityPercent: 60 },
        "Opportunity",
        user.id,
      );
    }
    revalidatePath("/quotations");
    revalidatePath(`/quotations/${id}`);
    revalidatePath("/opportunities");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not send the quote." };
  }
}

/** Why an approval rule holds a quote back, or null. */
export async function getQuoteApprovalReason(id: string): Promise<string | null> {
  const db = await supabaseServer();
  const { data } = await db.rpc("quotation_approval_reason", { p_id: id });
  return (data as string | null) ?? null;
}

/** Asks for approval of one of our quotes that is over an approval rule's limit. */
export async function requestQuotationApproval(id: string): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const db = await supabaseServer();
  const { error } = await db.rpc("request_quotation_approval", { p_id: id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/approvals");
  revalidatePath(`/quotations/${id}`);
  return { ok: true, data: undefined };
}

/**
 * Why a partner's quote cannot go to the customer yet, or null when it can.
 *
 * A quote a partner prepared is approved by one of our managers before it is
 * sent (20260928000006); the database refuses it regardless, and this says so
 * in words before an email is attempted. Our own quotes need no approval.
 */
function partnerQuoteUnapproved(q: {
  quoteNumber: string;
  preparedByPartnerId?: string | null;
  approvalStatus?: string | null;
}): string | null {
  if (!q.preparedByPartnerId || q.approvalStatus === "APPROVED") return null;
  return q.approvalStatus === "PENDING"
    ? `${q.quoteNumber} was prepared by a partner and is waiting for approval. Approve it before it is sent.`
    : `${q.quoteNumber} was prepared by a partner and has not been approved, so it cannot be sent yet.`;
}

/**
 * Approve a partner's quote so it can go to the customer, or send it back to
 * them with the reason. Only for somebody who may approve quotations; the
 * database checks that too, and that they can see the deal.
 */
export async function decideQuotationApproval(
  id: string,
  approve: boolean,
  note?: string | null,
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.QUOTATION_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  if (!approve && !note?.trim()) {
    return { ok: false, error: "Say why it is being sent back, so the partner knows what to change." };
  }

  const db = await supabaseServer();
  const { error } = await db.rpc("decide_quotation_approval", {
    p_id: id,
    p_approve: approve,
    p_note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/approvals");
  revalidatePath("/quotations");
  revalidatePath(`/quotations/${id}`);
  return { ok: true, data: undefined };
}

/**
 * Customer acceptance. This is the gate `changeStage` checks before a deal can
 * be marked Closed Won, so it is deliberately a separate, audited action.
 *
 * Accepting is accept_quotation(), in the database, because it is several
 * writes that must land together: the quote marked accepted, the deal's lines
 * replaced by the quote's, the deal moved on. The deal's amount follows from
 * its new lines, and partner commission from the amount.
 */
export async function decideQuotation(
  id: string,
  decision: "ACCEPTED" | "REJECTED",
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("quotation")
      .select("status, opportunityId, quoteNumber")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Quote not found." };

    if (before.status !== "SENT") {
      return {
        ok: false,
        error: "Only a quote that has been sent to the customer can be accepted or rejected.",
      };
    }

    if (decision === "ACCEPTED") {
      const { error } = await db.rpc("accept_quotation", { p_id: id });
      if (error) return { ok: false, error: error.message };
      revalidatePath(`/opportunities/${before.opportunityId}`);
    } else {
      await updateRecord(
        "quotation",
        id,
        { status: "REJECTED", acceptedAt: null },
        "Quotation",
        user.id,
      );
    }

    revalidatePath("/quotations");
    revalidatePath(`/quotations/${id}`);
    revalidatePath("/opportunities");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not record the decision." };
  }
}

export async function getQuotation(id: string) {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("quotation")
    .select(
      `*,
       opportunity ( id, opportunityNumber, name, stage ),
       account ( id, name ),
       contact ( id, firstName, lastName, email ),
       lines:quote_line ( *, product ( id, name, productCode ), taxRate:tax_rate ( id, name, ratePercent ) )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load quote: ${error.message}`);
  if (!data) return null;

  // PostgREST cannot order an embedded relation inline, so sortOrder is applied
  // here to preserve the original `orderBy: { sortOrder: "asc" }`.
  const quoteLines = ((data.lines ?? []) as Array<Record<string, unknown>>)
    .map((l) => ({ ...l, product: one(l.product), taxRate: one(l.taxRate) }))
    .sort(
      (a, b) =>
        Number((a as { sortOrder?: number }).sortOrder ?? 0) -
        Number((b as { sortOrder?: number }).sortOrder ?? 0),
    );

  return {
    ...data,
    opportunity: one(data.opportunity),
    account: one(data.account),
    contact: one(data.contact),
    lines: quoteLines,
  };
}

/** Everything the quote form needs about the deal it is for. */
export interface QuoteFormContext {
  opportunity: {
    id: string;
    opportunityNumber: string;
    name: string;
    accountId: string;
    primaryContactId: string | null;
    currencyCode: string;
    stage: string;
  } | null;
  /** The deal's own lines and book, and the catalogue: books, their prices, products and taxes. */
  pricing: OpportunityPricing | null;
  currencies: { code: string; name: string }[];
}

/**
 * The deal a quote is for, with what it sells and what it could be priced
 * from. Without a deal there is nothing to price yet - the form asks for one
 * first.
 */
export async function getQuoteFormContext(opportunityId?: string | null): Promise<QuoteFormContext> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  const [{ data: currencies }, opportunity, pricing] = await Promise.all([
    db.from("currency").select("code, name").eq("active", true).order("code"),
    opportunityId
      ? db
          .from("opportunity")
          .select("id, opportunityNumber, name, accountId, primaryContactId, currencyCode, stage")
          .eq("id", opportunityId)
          .is("deletedAt", null)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
    opportunityId ? getOpportunityPricing(opportunityId) : Promise.resolve(null),
  ]);

  return {
    opportunity: (opportunity as QuoteFormContext["opportunity"]) ?? null,
    pricing,
    currencies: (currencies ?? []) as QuoteFormContext["currencies"],
  };
}
