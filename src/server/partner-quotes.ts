"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { requireUser, AuthorizationError } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { loadOpportunityPricing, type OpportunityPricing } from "@/lib/opportunity-pricing";
import {
  dealLinesSchema, quoteInputSchema, lineForSave, type DealLinesInput, type QuoteInput,
} from "@/lib/priced-input";
import {
  renderDocumentEmail, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID,
} from "@/lib/email-template";
import { partnerQuoteEmailBlock } from "@/lib/partner-quote-rules";
// Plain, single-currency formatting: this goes to a customer.
import { formatMoneyPlain as formatMoney, formatDate } from "@/lib/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionResult } from "./partners";

/**
 * A partner pricing their deals and quoting them, from the portal.
 *
 * Reads go through the partner's session, so row-level security returns their
 * own deals' lines and quotes, and BabulTech's catalogue and theirs
 * (20260928000006). Writes are the partner_* functions there, each of which
 * checks the record is the partner's first.
 *
 * A quote a partner prepares is approved by one of our managers before it goes
 * to the customer, and once the customer accepts one the deal is what they
 * accepted - the partner can no longer change what was sold.
 */

async function requirePartner() {
  const user = await requireUser();
  if (!user.partnerId) throw new AuthorizationError("This account is not a partner portal login.");
  return user;
}

async function guarded<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  return fn();
}

function invalid<T>(error: z.ZodError): ActionResult<T> {
  return {
    ok: false,
    error: describeInvalid(error),
    fieldErrors: error.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** What the partner may sell: BabulTech's items and their own company's. */
async function sellableIds(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db.rpc("app_partner_catalogue_ids");
  const ids = (Array.isArray(data) ? data : []).map((row: unknown) =>
    typeof row === "string" ? row : (Object.values((row ?? {}) as Record<string, string>)[0] ?? null),
  );
  return new Set(ids.filter((id): id is string => Boolean(id)));
}

// ---------------------------------------------------------------------------
// The deal's products and services
// ---------------------------------------------------------------------------

export async function getPartnerDealPricing(dealId: string): Promise<OpportunityPricing | null> {
  await requirePartner();
  const db = await supabaseServer();
  return loadOpportunityPricing(db, dealId, { sellable: await sellableIds(db) });
}

/** Add Product & Service on one of the partner's deals: every line, saved together. */
export async function savePartnerDealLines(
  input: DealLinesInput,
): Promise<ActionResult<{ amount: string; lines: number }>> {
  return guarded(async () => {
    const parsed = dealLinesSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const d = parsed.data;
    if (d.lines.length > 0 && !d.priceBookId) {
      return { ok: false, error: "Choose the price book this deal is priced from." };
    }

    const db = await supabaseServer();
    const { data, error } = await db.rpc("partner_save_opportunity_lines", {
      p_opportunity: d.opportunityId,
      p_price_book: d.priceBookId || null,
      p_lines: d.lines.map((l) => lineForSave(l, true)),
    });
    if (error) return { ok: false, error: error.message };

    const result = data as { amount: number; lines: number };
    revalidatePath("/portal/deals");
    revalidatePath(`/portal/deals/${d.opportunityId}`);
    return { ok: true, data: { amount: String(result.amount), lines: result.lines } };
  });
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface PartnerQuoteFormContext {
  deal: {
    id: string;
    opportunityNumber: string;
    name: string;
    accountId: string;
    primaryContactId: string | null;
    currencyCode: string;
    stage: string;
  };
  pricing: OpportunityPricing;
  currencies: { code: string; name: string }[];
  /** The customer's people, whom the quote may be addressed to. */
  contacts: { id: string; name: string }[];
}

/** Everything the quote form needs about one of the partner's deals. */
export async function getPartnerQuoteFormContext(dealId: string): Promise<PartnerQuoteFormContext | null> {
  await requirePartner();
  const db = await supabaseServer();

  const { data: deal } = await db
    .from("opportunity")
    .select("id, opportunityNumber, name, accountId, primaryContactId, currencyCode, stage")
    .eq("id", dealId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!deal) return null;

  const [pricing, { data: currencies }, { data: people }] = await Promise.all([
    loadOpportunityPricing(db, dealId, { sellable: await sellableIds(db) }),
    db.from("currency").select("code, name").eq("active", true).order("code"),
    db.from("contact")
      .select("id, firstName, lastName")
      .eq("accountId", deal.accountId as string)
      .is("deletedAt", null)
      .eq("active", true)
      .order("firstName"),
  ]);
  if (!pricing) return null;

  return {
    deal: deal as PartnerQuoteFormContext["deal"],
    pricing,
    currencies: (currencies ?? []) as PartnerQuoteFormContext["currencies"],
    contacts: (people ?? []).map((p) => ({ id: p.id as string, name: `${p.firstName} ${p.lastName}`.trim() })),
  };
}

export interface PartnerQuoteLine {
  id: string;
  productId: string | null;
  priceBookEntryId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  licenseCost: string;
  maintenanceCost: string;
  cloudCost: string;
  aiCost: string;
  discountPercent: string | null;
  taxRateId: string | null;
  taxPercent: string;
  netTotal: string;
  lineTotal: string;
  sortOrder: number;
  product: { id: string; name: string; productCode: string } | null;
}

export interface PartnerQuote {
  id: string;
  quoteNumber: string;
  versionNumber: number;
  status: string;
  approvalStatus: string;
  approvalNote: string | null;
  approvalRequestedAt: string | null;
  approvalDecidedAt: string | null;
  preparedByPartnerId: string | null;
  opportunityId: string;
  contactId: string | null;
  quoteDate: string;
  expiryDate: string;
  currencyCode: string;
  priceBookId: string | null;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  paymentTerms: string | null;
  notes: string | null;
  termsAndConditions: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  opportunity: { id: string; opportunityNumber: string; name: string; stage: string; accountId: string } | null;
  account: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string; email: string | null } | null;
  lines: PartnerQuoteLine[];
  versions: { id: string; quoteNumber: string; versionNumber: number; status: string; totalAmount: string }[];
}

export async function getPartnerQuote(id: string): Promise<PartnerQuote | null> {
  await requirePartner();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("quotation")
    .select(
      `id, quoteNumber, versionNumber, status, approvalStatus, approvalNote, approvalRequestedAt,
       approvalDecidedAt, preparedByPartnerId, opportunityId, contactId, quoteDate, expiryDate,
       currencyCode, priceBookId, subtotal, discountAmount, taxAmount, totalAmount, paymentTerms,
       notes, termsAndConditions, sentAt, acceptedAt,
       opportunity ( id, opportunityNumber, name, stage, accountId ),
       account ( id, name ),
       contact ( id, firstName, lastName, email ),
       lines:quote_line (
         id, productId, priceBookEntryId, description, quantity, unitPrice, licenseCost,
         maintenanceCost, cloudCost, aiCost, discountPercent, taxRateId, taxPercent, netTotal,
         lineTotal, sortOrder,
         product ( id, name, productCode )
       )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load the quote: ${error.message}`);
  if (!data) return null;

  const { data: versions } = await db
    .from("quotation")
    .select("id, quoteNumber, versionNumber, status, totalAmount")
    .eq("opportunityId", data.opportunityId as string)
    .is("deletedAt", null)
    .order("versionNumber", { ascending: false });

  return {
    ...(data as unknown as PartnerQuote),
    opportunity: one(data.opportunity as never),
    account: one(data.account as never),
    contact: one(data.contact as never),
    // PostgREST cannot order an embedded relation inline.
    lines: ((data.lines ?? []) as unknown as PartnerQuoteLine[])
      .map((l) => ({ ...l, product: one(l.product as never) }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    versions: (versions ?? []) as PartnerQuote["versions"],
  };
}

/** The header and lines as the partner_* quote functions take them. */
function quoteForSave(d: QuoteInput) {
  return {
    header: {
      contactId: d.contactId ?? null,
      quoteDate: d.quoteDate.toISOString().slice(0, 10),
      expiryDate: d.expiryDate.toISOString().slice(0, 10),
      currencyCode: d.currencyCode,
      priceBookId: d.priceBookId || null,
      paymentTerms: d.paymentTerms ?? null,
      notes: d.notes ?? null,
      termsAndConditions: d.termsAndConditions ?? null,
    },
    lines: d.lines.map((l) => lineForSave(l, false)),
  };
}

function checkDates(d: QuoteInput): ActionResult<never> | null {
  if (d.expiryDate < d.quoteDate) {
    return {
      ok: false,
      error: "A quote cannot expire before it is issued.",
      fieldErrors: { expiryDate: ["Must be on or after the quote date."] },
    };
  }
  return null;
}

/** A new draft on one of the partner's deals, theirs to have approved. */
export async function createPartnerQuote(input: QuoteInput): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const parsed = quoteInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const d = parsed.data;
    const bad = checkDates(d);
    if (bad) return bad;

    const { header, lines } = quoteForSave(d);
    const db = await supabaseServer();
    const { data, error } = await db.rpc("partner_create_quotation", {
      p_opportunity: d.opportunityId,
      p_quote: header,
      p_lines: lines,
    });
    if (error) return { ok: false, error: error.message };

    revalidatePath(`/portal/deals/${d.opportunityId}`);
    return { ok: true, data: { id: (data as { id: string }).id } };
  });
}

/** A draft, or an approved quote not yet sent - which then needs approving again. */
export async function updatePartnerQuote(id: string, input: QuoteInput): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const parsed = quoteInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const d = parsed.data;
    const bad = checkDates(d);
    if (bad) return bad;

    const { header, lines } = quoteForSave(d);
    const db = await supabaseServer();
    const { error } = await db.rpc("partner_update_quotation", { p_id: id, p_quote: header, p_lines: lines });
    if (error) return { ok: false, error: error.message };

    revalidatePath(`/portal/quotes/${id}`);
    revalidatePath(`/portal/deals/${d.opportunityId}`);
    return { ok: true, data: { id } };
  });
}

/** One quote transition, through its partner_* function. */
async function transition(fn: string, args: Record<string, unknown>, id: string): Promise<ActionResult> {
  return guarded(async () => {
    const db = await supabaseServer();
    const { error } = await db.rpc(fn, args);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/portal/quotes/${id}`);
    revalidatePath("/portal/deals");
    return { ok: true, data: undefined };
  });
}

/** Ask our managers to approve it, so it can go to the customer. */
export async function askPartnerQuoteApproval(id: string): Promise<ActionResult> {
  return transition("partner_request_quotation_approval", { p_id: id }, id);
}

/** Take a quote back from approval, to change it. */
export async function withdrawPartnerQuoteApproval(id: string): Promise<ActionResult> {
  return transition("partner_withdraw_quotation_approval", { p_id: id }, id);
}

/** Record that an approved quote went to the customer by other means. */
export async function markPartnerQuoteSent(id: string): Promise<ActionResult> {
  return transition("partner_send_quotation", { p_id: id }, id);
}

/**
 * The customer's answer. Accepting puts the quote's products and services on
 * the deal in place of what is there and moves it to Verbal Confirmation.
 */
export async function decidePartnerQuote(id: string, decision: "ACCEPTED" | "REJECTED"): Promise<ActionResult> {
  return transition("partner_decide_quotation", { p_id: id, p_accepted: decision === "ACCEPTED" }, id);
}

/** A new version of a quote the customer has seen, starting as the partner's draft. */
export async function revisePartnerQuote(id: string): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const db = await supabaseServer();
    const { data, error } = await db.rpc("partner_revise_quotation", { p_id: id });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/portal/deals");
    return { ok: true, data: { id: (data as { id: string }).id } };
  });
}

// ---------------------------------------------------------------------------
// Emailing a quote to the customer
// ---------------------------------------------------------------------------

const emailSchema = z.object({
  to: z.string().email("That does not look like an email address."),
  cc: z.string().optional().nullable(),
  subject: z.string().trim().min(1, "Give the email a subject.").max(500),
  message: z.string().trim().min(1, "Write something in the body."),
});

/**
 * Email the quote to the customer from BabulTech's address, in the partner's
 * name with their email as the reply-to, as the partner's other emails go.
 * The first send marks the quote sent and moves an early deal on, exactly as
 * "Mark as sent" does.
 */
export async function emailPartnerQuote(
  id: string,
  input: z.infer<typeof emailSchema>,
): Promise<ActionResult<{ id: string }>> {
  let user;
  try {
    user = await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const d = parsed.data;

  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "Email is not set up yet, so nothing can be sent from here." };

  const db = await supabaseServer();
  const [{ data: quote }, { data: partner }] = await Promise.all([
    db.from("quotation")
      .select("id, quoteNumber, status, preparedByPartnerId, quoteDate, expiryDate, totalAmount, currencyCode, opportunityId")
      .eq("id", id)
      .is("deletedAt", null)
      .maybeSingle(),
    db.from("partner").select("displayName, email, status").eq("id", user.partnerId!).maybeSingle(),
  ]);
  if (!quote) return { ok: false, error: "That quote is not one of yours." };
  if (!partner || partner.status !== "ACTIVE") {
    return { ok: false, error: "Only an active partnership can send email. Please speak to your partner manager." };
  }
  const blocked = partnerQuoteEmailBlock(quote as never);
  if (blocked) return { ok: false, error: blocked };

  const admin = supabaseAdmin();
  const { data: settingsRow } = await admin.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settingsRow));

  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: `Quotation ${quote.quoteNumber}`,
    message: d.message,
    summary: [
      { label: "Quotation", value: String(quote.quoteNumber) },
      { label: "Date", value: formatDate(quote.quoteDate as string) },
      { label: "Valid until", value: formatDate(quote.expiryDate as string) },
      { label: "Total", value: formatMoney(quote.totalAmount as string, quote.currencyCode as string), emphasis: true },
    ],
    senderName: `${user.fullName}, ${partner.displayName}`,
  });

  const address = (process.env.EMAIL_FROM ?? "BabulTech <onboarding@resend.dev>").replace(/^.*</, "").replace(/>$/, "");
  const from = `${partner.displayName} via BabulTech <${address}>`;
  const cc = (d.cc ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rowId = randomUUID();
  const now = new Date().toISOString();

  // Recorded before it is sent, so a send that fails midway still leaves a
  // trace - as our own quote emails are.
  const { error: writeError } = await admin.from("email").insert({
    id: rowId,
    updatedAt: now,
    direction: "OUTBOUND",
    subject: d.subject,
    fromAddress: from,
    toAddresses: [d.to],
    ccAddresses: cc.length ? cc : null,
    bodyHtml: html,
    bodyText: text,
    relatedEntityType: "Quotation",
    relatedEntityId: id,
    sentReceivedAt: now,
    status: "DRAFT",
    hasAttachments: false,
  });
  if (writeError) return { ok: false, error: writeError.message };

  const { data: sent, error: sendError } = await new Resend(key).emails.send({
    from,
    to: d.to,
    cc: cc.length ? cc : undefined,
    replyTo: (partner.email as string | null) ?? user.email,
    subject: d.subject,
    html,
    text,
  });

  if (sendError) {
    await admin.from("email").update({ status: "FAILED", updatedAt: new Date().toISOString() }).eq("id", rowId);
    return { ok: false, error: `Could not send: ${sendError.message}` };
  }
  await admin
    .from("email")
    .update({ status: "SENT", messageId: sent?.id ?? null, updatedAt: new Date().toISOString() })
    .eq("id", rowId);

  if (quote.status !== "SENT") {
    const { error } = await db.rpc("partner_send_quotation", { p_id: id });
    if (error) {
      return { ok: false, error: `The email went to ${d.to}, but the quote could not be marked as sent: ${error.message}` };
    }
  }

  revalidatePath(`/portal/quotes/${id}`);
  revalidatePath(`/portal/deals/${quote.opportunityId}`);
  return { ok: true, data: { id: rowId } };
}

/** What has been emailed about one of the partner's quotes. */
export async function listPartnerQuoteEmails(id: string) {
  await requirePartner();
  const db = await supabaseServer();
  // Theirs first: the history is read with our key, so the quote must be one
  // the partner can see.
  const { data: quote } = await db.from("quotation").select("id").eq("id", id).maybeSingle();
  if (!quote) return [];

  const { data } = await supabaseAdmin()
    .from("email")
    .select("id, subject, toAddresses, status, sentReceivedAt, direction")
    .eq("relatedEntityType", "Quotation")
    .eq("relatedEntityId", id)
    .order("sentReceivedAt", { ascending: false })
    .limit(50);
  return (data ?? []) as {
    id: string;
    subject: string;
    toAddresses: unknown;
    status: string;
    sentReceivedAt: string;
    direction: string;
  }[];
}
