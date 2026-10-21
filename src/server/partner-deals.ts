"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { requireUser, AuthorizationError } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { duplicateFailure } from "@/lib/duplicates";
import { DEAL_STAGES, type DealStage } from "@/lib/deal-stages";
import type { ActionResult } from "./partners";

/**
 * A partner's own deals, accounts and people, as the portal edits them.
 *
 * Reads go through the partner's session, so row-level security returns only
 * what the partner brought us. Writes are the partner_* functions in
 * 20260928000005_partner_deals.sql, each of which checks the record is the
 * partner's first.
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

const blank = (max: number) => z.string().trim().max(max).optional().nullable().or(z.literal(""));

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface PartnerDeal {
  id: string;
  opportunityNumber: string;
  name: string;
  stage: string;
  amount: string | number;
  netAmount: string | number;
  taxAmount: string | number;
  pricedByLines: boolean;
  currencyCode: string;
  probabilityPercent: string | number | null;
  expectedCloseDate: string;
  actualCloseDate: string | null;
  opportunityType: string | null;
  leadSource: string | null;
  nextStep: string | null;
  competitorName: string | null;
  lossReason: string | null;
  description: string | null;
  primaryContactId: string | null;
  createdAt: string;
  account: { id: string; name: string } | null;
  primaryContact: { id: string; firstName: string; lastName: string } | null;
  contacts: { id: string; firstName: string; lastName: string }[];
  quotations: {
    id: string;
    quoteNumber: string;
    versionNumber: number;
    status: string;
    approvalStatus: string;
    preparedByPartnerId: string | null;
    totalAmount: string | number;
    currencyCode: string;
  }[];
  commission: {
    id: string;
    status: string;
    commissionPercent: string | number;
    partnerAmount: string | number;
    paymentDate: string | null;
  } | null;
}

export async function getPartnerDeal(id: string): Promise<PartnerDeal | null> {
  await requirePartner();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("opportunity")
    .select(
      `id, opportunityNumber, name, stage, amount, netAmount, taxAmount, pricedByLines, currencyCode,
       probabilityPercent, expectedCloseDate, actualCloseDate, opportunityType, leadSource,
       nextStep, competitorName, lossReason, description, primaryContactId, createdAt, accountId,
       account ( id, name ),
       primaryContact:contact!opportunity_primaryContactId_fkey ( id, firstName, lastName ),
       quotations:quotation (
         id, quoteNumber, versionNumber, status, approvalStatus, preparedByPartnerId,
         totalAmount, currencyCode, deletedAt
       )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load the deal: ${error.message}`);
  if (!data) return null;

  const [{ data: contacts }, { data: commission }] = await Promise.all([
    db.from("contact")
      .select("id, firstName, lastName")
      .eq("accountId", data.accountId as string)
      .is("deletedAt", null)
      .eq("active", true)
      .order("firstName"),
    db.from("partner_commission")
      .select("id, status, commissionPercent, partnerAmount, paymentDate")
      .eq("opportunityId", id)
      .maybeSingle(),
  ]);

  return {
    ...(data as unknown as PartnerDeal),
    account: one(data.account as never),
    primaryContact: one(data.primaryContact as never),
    contacts: (contacts ?? []) as PartnerDeal["contacts"],
    quotations: ((data.quotations ?? []) as (PartnerDeal["quotations"][number] & { deletedAt: string | null })[])
      .filter((q) => !q.deletedAt)
      .sort((a, b) => b.versionNumber - a.versionNumber),
    commission: (commission as PartnerDeal["commission"]) ?? null,
  };
}

const dealSchema = z.object({
  name: z.string().trim().min(1, "The deal needs a name.").max(255),
  primaryContactId: z.string().uuid().optional().nullable().or(z.literal("")),
  amount: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().min(0, "An amount cannot be negative.").nullable()).optional(),
  currencyCode: z.string().trim().length(3).optional(),
  probabilityPercent: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().min(0).max(100).nullable()).optional(),
  expectedCloseDate: z.string().trim().min(1, "When do you expect to close?"),
  opportunityType: blank(40),
  leadSource: blank(100),
  nextStep: blank(500),
  competitorName: blank(200),
  description: z.string().trim().max(8000).optional().nullable().or(z.literal("")),
});

export type PartnerDealInput = z.infer<typeof dealSchema>;

/** Everything on the deal except owner, campaign and stage. */
export async function updatePartnerDeal(id: string, input: PartnerDealInput): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const parsed = dealSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: describeInvalid(parsed.error),
        fieldErrors: parsed.error.flatten().fieldErrors,
      };
    }
    const db = await supabaseServer();
    const { error } = await db.rpc("partner_update_opportunity", {
      p_id: id,
      p_deal: { ...parsed.data, amount: parsed.data.amount ?? "", probabilityPercent: parsed.data.probabilityPercent ?? "" },
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/portal/deals");
    revalidatePath(`/portal/deals/${id}`);
    return { ok: true, data: { id } };
  });
}

/**
 * Move a deal on. Winning needs an amount, a product or service and an
 * accepted quote, and starts the delivery project; losing needs a reason - the
 * same rules our team closes by.
 */
export async function setPartnerDealStage(
  id: string,
  stage: DealStage,
  lossReason?: string,
  competitorName?: string,
): Promise<ActionResult<{ projectNumber: string | null; projectError: string | null }>> {
  return guarded(async () => {
    if (!DEAL_STAGES.includes(stage)) return { ok: false, error: "That is not a stage a deal can be at." };
    const db = await supabaseServer();
    const { data, error } = await db.rpc("partner_set_opportunity_stage", {
      p_id: id,
      p_stage: stage,
      p_loss_reason: lossReason?.trim() || null,
      p_competitor: competitorName?.trim() || null,
    });
    if (error) return { ok: false, error: error.message };
    const result = data as { projectNumber: string | null; projectError: string | null };
    revalidatePath("/portal/deals");
    revalidatePath(`/portal/deals/${id}`);
    revalidatePath("/portal/commissions");
    return { ok: true, data: result };
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const accountSchema = z.object({
  name: z.string().trim().min(2, "Give the company a name.").max(200),
  industry: blank(100),
  website: blank(255),
  mainPhone: blank(50),
  employeeCount: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().min(0).nullable()).optional(),
  description: z.string().trim().max(8000).optional().nullable().or(z.literal("")),
  billingAddress: z.object({
    street: blank(255),
    city: blank(100),
    state: blank(100),
    postalCode: blank(30),
    country: blank(100),
  }),
});

export type PartnerAccountInput = z.infer<typeof accountSchema>;

export async function updatePartnerAccount(id: string, input: PartnerAccountInput): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const parsed = accountSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: describeInvalid(parsed.error),
        fieldErrors: parsed.error.flatten().fieldErrors,
      };
    }
    const db = await supabaseServer();
    const { error } = await db.rpc("partner_update_account", {
      p_id: id,
      p_account: { ...parsed.data, employeeCount: parsed.data.employeeCount ?? "" },
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath("/portal/customers");
    revalidatePath(`/portal/customers/${id}`);
    return { ok: true, data: { id } };
  });
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PartnerContact {
  id: string;
  accountId: string | null;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  whatsapp: string | null;
  isPrimary: boolean;
}

export async function getPartnerContact(id: string): Promise<PartnerContact | null> {
  await requirePartner();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("contact")
    .select("id, accountId, firstName, lastName, jobTitle, department, email, phone, mobile, whatsapp, isPrimary")
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();
  if (error) throw new Error(`Could not load the contact: ${error.message}`);
  return (data as PartnerContact) ?? null;
}

const contactSchema = z.object({
  firstName: z.string().trim().min(1, "The contact needs a first name.").max(100),
  lastName: z.string().trim().min(1, "The contact needs a last name.").max(100),
  jobTitle: blank(150),
  department: blank(100),
  email: z.string().trim().email("That does not look like an email address.").optional().nullable().or(z.literal("")),
  phone: blank(50),
  mobile: blank(50),
  whatsapp: blank(50),
  isPrimary: z.boolean().optional(),
});

export type PartnerContactInput = z.infer<typeof contactSchema>;

/** Add a person to one of the partner's accounts (id null), or edit one. */
export async function savePartnerContact(
  id: string | null,
  accountId: string,
  input: PartnerContactInput,
): Promise<ActionResult<{ id: string }>> {
  return guarded(async () => {
    const parsed = contactSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: describeInvalid(parsed.error),
        fieldErrors: parsed.error.flatten().fieldErrors,
      };
    }
    const db = await supabaseServer();
    const { data, error } = await db.rpc("partner_save_contact", {
      p_id: id,
      p_account_id: accountId,
      p_contact: parsed.data,
    });
    if (error) return duplicateFailure(error, "portal") ?? { ok: false, error: error.message };
    revalidatePath(`/portal/customers/${accountId}`);
    return { ok: true, data: { id: (data as { id: string }).id } };
  });
}
