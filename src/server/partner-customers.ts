"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { getPortalContext } from "./portal";
import type { ActionResult } from "./partners";

/**
 * What a partner may create: customers, their people, and deals against them.
 *
 * Every write here is one `.rpc()` call to a SECURITY DEFINER function, never
 * an insert. Partners hold no INSERT policy on account, contact or opportunity,
 * so the set of things a partner can create is defined by those functions'
 * arguments rather than by the tables' columns — a much smaller thing to keep
 * correct as the schema grows.
 *
 * The functions do their own authorisation from app_current_partner_id(), which
 * is read from the session in the database. The checks in this file are there
 * to give a decent error message before a round trip, not to be the guard.
 */

/**
 * The shape partner_find_conflict returns.
 *
 * A partner sees their own records and nobody else's, so a clash with a
 * customer that is not theirs says only that it exists and what matched. The
 * description of the customer comes back only when it is the partner's own.
 */
export interface RegistrationConflict {
  conflict: boolean;
  /** True when the existing customer is one this partner already brought. */
  mine?: boolean;
  /**
   * What matched. A contact's email or phone number means the person is already
   * on file, and the duplicate rule will refuse them; a company name only flags.
   */
  matchedOn?: "email" | "phone" | "name";
  accountName?: string;
  city?: string | null;
  accountType?: string;
  customerStatus?: string | null;
  registeredOn?: string;
}

async function requirePartnerId(): Promise<string> {
  const ctx = await getPortalContext();
  if (!ctx?.partnerId) throw new Error("Your session has ended. Sign in again and retry.");
  return ctx.partnerId;
}

const conflictSchema = z.object({
  accountName: z.string().trim().min(1),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().optional(),
});

/**
 * Is this customer already known to us?
 *
 * Called as the partner types, before anything is written, so they find out
 * about a clash while they can still do something about it.
 */
export async function checkCustomerConflict(
  input: z.infer<typeof conflictSchema>,
): Promise<ActionResult<RegistrationConflict>> {
  try {
    await requirePartnerId();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = conflictSchema.safeParse(input);
  if (!parsed.success) return { ok: true, data: { conflict: false } };

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_find_conflict", {
    p_account_name: parsed.data.accountName,
    p_email: parsed.data.email || null,
    p_phone: parsed.data.phone || null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? { conflict: false }) as RegistrationConflict };
}

const customerSchema = z.object({
  accountName: z.string().trim().min(2, "Give the company a name.").max(200),
  firstName: z.string().trim().min(1, "The contact needs a first name.").max(100),
  lastName: z.string().trim().min(1, "The contact needs a last name.").max(100),
  email: z.string().trim().email("That does not look like an email address.").optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional(),
  jobTitle: z.string().trim().max(150).optional(),
  industry: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  website: z.string().trim().max(255).optional(),
  // The deal is optional: a partner often has the customer before they have a
  // number to put on it, and an invented figure makes the pipeline worse.
  dealName: z.string().trim().max(255).optional(),
  dealAmount: z.coerce.number().min(0).optional(),
  dealCloseDate: z.string().trim().optional(),
  dealCurrency: z.string().trim().length(3).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export interface CreatedCustomer {
  accountId: string;
  accountNumber: string;
  contactId: string;
  opportunityId: string | null;
  opportunityNumber: string | null;
  contested: boolean;
  conflict: RegistrationConflict;
}

/** Create the account, its primary contact, and optionally the first deal. */
export async function createPartnerCustomer(
  input: z.infer<typeof customerSchema>,
): Promise<ActionResult<CreatedCustomer>> {
  try {
    await requirePartnerId();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = customerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_create_customer", {
    p_account_name: d.accountName,
    p_first_name: d.firstName,
    p_last_name: d.lastName,
    p_email: d.email || null,
    p_phone: d.phone || null,
    p_job_title: d.jobTitle || null,
    p_industry: d.industry || null,
    p_city: d.city || null,
    p_website: d.website || null,
    p_deal_name: d.dealName || null,
    p_deal_amount: d.dealAmount ?? null,
    p_deal_close: d.dealCloseDate || null,
    p_deal_currency: d.dealCurrency || "PKR",
    p_notes: d.notes || null,
  });

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "The customer was not created." };

  revalidatePath("/portal/deals");
  revalidatePath("/portal");
  return { ok: true, data: data as CreatedCustomer };
}

const contactSchema = z.object({
  accountId: z.string().uuid(),
  firstName: z.string().trim().min(1, "The contact needs a first name.").max(100),
  lastName: z.string().trim().min(1, "The contact needs a last name.").max(100),
  email: z.string().trim().email("That does not look like an email address.").optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional(),
  jobTitle: z.string().trim().max(150).optional(),
});

/** Add another person at a customer this partner already brought. */
export async function addPartnerContact(
  input: z.infer<typeof contactSchema>,
): Promise<ActionResult<{ contactId: string }>> {
  try {
    await requirePartnerId();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_add_contact", {
    p_account_id: d.accountId,
    p_first_name: d.firstName,
    p_last_name: d.lastName,
    p_email: d.email || null,
    p_phone: d.phone || null,
    p_job_title: d.jobTitle || null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data as { contactId: string } };
}

const dealSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().trim().min(2, "Give the deal a name.").max(255),
  amount: z.coerce.number().min(0).optional(),
  closeDate: z.string().trim().optional(),
  currencyCode: z.string().trim().length(3).optional(),
  contactId: z.string().uuid().optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional(),
  dealType: z.string().trim().max(50).optional(),
  nextStep: z.string().trim().max(500).optional(),
  competitorName: z.string().trim().max(200).optional(),
  // A buyer typed in rather than chosen. Both names or neither — the
  // database treats a half-filled person as no person at all.
  newFirstName: z.string().trim().max(100).optional(),
  newLastName: z.string().trim().max(100).optional(),
  newJobTitle: z.string().trim().max(150).optional(),
  newEmail: z.string().trim().email("That does not look like an email address.").optional().or(z.literal("")),
  newPhone: z.string().trim().max(50).optional(),
  street: z.string().trim().max(255).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  country: z.string().trim().max(100).optional(),
  // The partner's own read of the deal. They are closer to it than we are.
  probabilityPercent: z.coerce.number().min(0).max(100).optional(),
  leadSource: z.string().trim().max(100).optional(),
});

/**
 * The customers a partner may raise a deal against.
 *
 * Only the ones they sourced, which is the same rule the write path
 * enforces - offering an account the function would refuse is how somebody
 * ends up staring at "that customer is not one of yours".
 */
export async function listMyAccountsForDeal(): Promise<
  { id: string; name: string; accountNumber: string }[]
> {
  await requirePartnerId();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("account")
    .select("id, name, accountNumber")
    .is("deletedAt", null)
    .order("name");

  if (error) throw new Error(`Could not load your accounts: ${error.message}`);
  return data ?? [];
}

/** Add a deal against a customer this partner already brought. */
export async function addPartnerOpportunity(
  input: z.infer<typeof dealSchema>,
): Promise<ActionResult<{ opportunityId: string; opportunityNumber: string; contactId: string | null }>> {
  try {
    await requirePartnerId();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = dealSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_add_opportunity", {
    p_account_id: d.accountId,
    p_name: d.name,
    p_amount: d.amount ?? 0,
    p_close_date: d.closeDate || null,
    p_currency: d.currencyCode || "PKR",
    p_contact_id: d.contactId || null,
    p_notes: d.notes || null,
    p_deal_type: d.dealType || null,
    p_next_step: d.nextStep || null,
    p_competitor: d.competitorName || null,
    p_new_first: d.newFirstName || null,
    p_new_last: d.newLastName || null,
    p_new_title: d.newJobTitle || null,
    p_new_email: d.newEmail || null,
    p_new_phone: d.newPhone || null,
    p_street: d.street || null,
    p_city: d.city || null,
    p_state: d.state || null,
    p_postal_code: d.postalCode || null,
    p_country: d.country || null,
    p_probability: d.probabilityPercent ?? null,
    p_lead_source: d.leadSource || null,
  });

  if (error) return { ok: false, error: error.message };
  revalidatePath("/portal/deals");
  return { ok: true, data: data as { opportunityId: string; opportunityNumber: string; contactId: string | null } };
}

/**
 * The customers this partner brought, with their people and deals.
 *
 * Separate from getPortalAccounts(), which derives accounts from deal links.
 * That view answers "whose deals am I on"; this one answers "whose customers
 * are mine", and only the second may be added to.
 */
export async function listMyCustomers() {
  await requirePartnerId();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("account")
    .select(
      `id, accountNumber, name, accountType, customerStatus, industry, website,
       registrationContested, createdAt,
       contacts:contact ( id, firstName, lastName, jobTitle, email, phone, isPrimary ),
       opportunities:opportunity ( id, opportunityNumber, name, stage, amount, currencyCode, expectedCloseDate )`,
    )
    .is("deletedAt", null)
    .order("createdAt", { ascending: false });

  if (error) throw new Error(`Could not load your customers: ${error.message}`);
  // No partner filter needed: account_partner_read already limits this to the
  // accounts this partner sourced. Filtering again here would hide a policy bug
  // rather than surface it.
  return data ?? [];
}

/**
 * One account this partner sourced, with its people and its opportunities.
 *
 * Shaped like the CRM's own account page so both sides read the same record the
 * same way. What is not selected is what belongs to us: the internal owner, the
 * health score, cases, invoices and anything financial. RLS would refuse most
 * of it anyway; leaving it out of the query says so plainly rather than relying
 * on a policy to silently blank it.
 */
export async function getMyCustomer(id: string) {
  await requirePartnerId();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("account")
    .select(
      `id, accountNumber, name, accountType, customerStatus, industry, website,
       mainPhone, employeeCount, billingAddress, description,
       registrationContested, createdAt,
       contacts:contact ( id, firstName, lastName, jobTitle, email, phone, mobile,
                          isPrimary, active, createdAt ),
       opportunities:opportunity ( id, opportunityNumber, name, stage, amount,
                                   currencyCode, expectedCloseDate, actualCloseDate,
                                   nextStep, deletedAt )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load the account: ${error.message}`);
  if (!data) return null;

  return {
    ...data,
    contacts: (data.contacts ?? []).filter((c: { active?: boolean }) => c.active !== false),
    opportunities: (data.opportunities ?? []).filter(
      (o: { deletedAt?: string | null }) => !o.deletedAt,
    ),
  };
}
