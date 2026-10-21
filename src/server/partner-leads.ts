"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { requireUser, AuthorizationError } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { prepareLeadEmails, type SendResult } from "@/lib/lead-mailer";
import { queueJob } from "@/lib/jobs";
import { duplicateFailure } from "@/lib/duplicates";
import type { ActionResult } from "./partners";

/**
 * A partner's own leads, in the portal: listing, creating, editing, importing,
 * working them - calls, meetings, notes, follow-ups, email - and converting.
 *
 * Reads go through the partner's own session, so row-level security returns
 * their company's leads and nothing else (lead_partner_read). Writes are the
 * partner_* functions in 20260928000004_partner_leads.sql, each of which checks
 * the record is the partner's before touching it; the checks here are for a
 * decent message, not the guard.
 */

async function requirePartner() {
  const user = await requireUser();
  if (!user.partnerId) throw new AuthorizationError("This account is not a partner portal login.");
  return user;
}

export interface PartnerLead {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string;
  companyName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  industry: string | null;
  website: string | null;
  businessType: string | null;
  companySize: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  leadSource: string | null;
  rating: string | null;
  estimatedValue: string | number | null;
  description: string | null;
  nextFollowUpAt: string | null;
  status: string;
  disqualifiedReason: string | null;
  convertedAt: string | null;
  convertedAccountId: string | null;
  convertedOpportunityId: string | null;
  createdAt: string;
  updatedAt: string;
}

const LEAD_COLUMNS = `
  id, leadNumber, firstName, lastName, companyName, jobTitle, email, phone, whatsapp,
  industry, website, businessType, companySize, street, city, state, postalCode, country,
  leadSource, rating, estimatedValue, description, nextFollowUpAt, status, disqualifiedReason,
  convertedAt, convertedAccountId, convertedOpportunityId, createdAt, updatedAt
`;

/** The partner's leads, newest first. Converted ones are kept for the record. */
export async function listPartnerLeads(filters: { search?: string; status?: string } = {}): Promise<PartnerLead[]> {
  await requirePartner();
  const db = await supabaseServer();

  let query = db
    .from("lead")
    .select(LEAD_COLUMNS)
    .is("deletedAt", null)
    .is("mergedIntoId", null)
    .order("createdAt", { ascending: false })
    .limit(500);

  if (filters.status) query = query.eq("status", filters.status);
  const term = filters.search?.replace(/[,()]/g, "").trim();
  if (term) {
    query = query.or(
      ["firstName", "lastName", "companyName", "email", "phone", "leadNumber"]
        .map((c) => `${c}.ilike.%${term}%`)
        .join(","),
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load your leads: ${error.message}`);
  return (data ?? []) as unknown as PartnerLead[];
}

export async function getPartnerLead(id: string): Promise<PartnerLead | null> {
  await requirePartner();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("lead")
    .select(LEAD_COLUMNS)
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();
  if (error) throw new Error(`Could not load the lead: ${error.message}`);
  return (data as unknown as PartnerLead) ?? null;
}

const text = (max: number) => z.string().trim().max(max).optional().nullable().or(z.literal(""));

const leadSchema = z.object({
  firstName: z.string().trim().min(1, "The lead needs a first name.").max(100),
  lastName: z.string().trim().min(1, "The lead needs a last name.").max(100),
  companyName: text(200),
  jobTitle: text(150),
  email: z.string().trim().email("That does not look like an email address.").optional().nullable().or(z.literal("")),
  phone: text(50),
  whatsapp: text(50),
  industry: text(100),
  website: text(255),
  businessType: text(100),
  companySize: text(30),
  street: text(255),
  city: text(100),
  state: text(100),
  postalCode: text(30),
  country: text(100),
  leadSource: text(100),
  rating: text(30),
  estimatedValue: z.preprocess(
    (v) => (v === "" || v == null ? null : v),
    z.coerce.number().min(0, "An estimate cannot be negative.").nullable(),
  ).optional(),
  description: z.string().trim().max(8000).optional().nullable().or(z.literal("")),
  nextFollowUpAt: text(40),
  status: z.enum([
    "NEW", "ASSIGNED", "ATTEMPTED_CONTACT", "CONTACTED", "DISCOVERY_SCHEDULED",
    "QUALIFIED", "NURTURING", "DISQUALIFIED",
  ]).optional(),
  disqualifiedReason: text(255),
});

export type PartnerLeadInput = z.infer<typeof leadSchema>;

/** Create (id null) or edit one of the partner's leads. */
export async function savePartnerLead(
  id: string | null,
  input: PartnerLeadInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_save_lead", { p_id: id, p_lead: parsed.data });
  if (error) return duplicateFailure(error, "portal") ?? { ok: false, error: error.message };

  const saved = data as { id: string };
  revalidatePath("/portal/leads");
  revalidatePath(`/portal/leads/${saved.id}`);
  return { ok: true, data: { id: saved.id } };
}

export interface PartnerImportResult {
  created: number;
  skipped: { row: number; name: string; reason: string }[];
}

/** Import a mapped list; people already on file are left out and listed. */
export async function importPartnerLeads(
  rows: PartnerLeadInput[],
): Promise<ActionResult<PartnerImportResult>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  if (!rows.length) return { ok: false, error: "There is nothing in that file." };
  if (rows.length > 500) return { ok: false, error: `That file has ${rows.length} rows. Import up to 500 at a time.` };

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_import_leads", { p_rows: rows });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/portal/leads");
  return { ok: true, data: data as PartnerImportResult };
}

const convertSchema = z.object({
  leadId: z.string().uuid(),
  createOpportunity: z.boolean().default(true),
  opportunityName: z.string().trim().max(255).optional().or(z.literal("")),
  amount: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().min(0).nullable()).optional(),
  expectedCloseDate: z.string().trim().optional().or(z.literal("")),
});

/** Turn a lead into a customer, their contact and, if asked, a deal - all credited to the partner. */
export async function convertPartnerLead(
  input: z.infer<typeof convertSchema>,
): Promise<ActionResult<{ accountId: string; contactId: string; opportunityId: string | null; reusedContact: boolean }>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const parsed = convertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const d = parsed.data;

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_convert_lead", {
    p_lead_id: d.leadId,
    p_create_opportunity: d.createOpportunity,
    p_opportunity_name: d.opportunityName || null,
    p_amount: d.amount ?? null,
    p_expected_close: d.expectedCloseDate || null,
  });
  if (error) return duplicateFailure(error, "portal") ?? { ok: false, error: error.message };

  revalidatePath("/portal/leads");
  revalidatePath(`/portal/leads/${d.leadId}`);
  revalidatePath("/portal/customers");
  revalidatePath("/portal/deals");
  return { ok: true, data: data as never };
}

// ---------------------------------------------------------------------------
// What was done
// ---------------------------------------------------------------------------

export type PartnerActivityEntity = "Lead" | "Account" | "Contact" | "Opportunity";

export interface PartnerActivity {
  id: string;
  activityType: string;
  subject: string;
  description: string | null;
  outcome: string | null;
  status: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  toAddress: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  unsubscribedAt: string | null;
  owner: { fullName: string } | null;
}

/**
 * What the partner's company has done on one of its records. Our own team's
 * notes on the same record are ours, and never come back here
 * (activity_partner_read).
 */
export async function listPartnerActivities(
  entityType: PartnerActivityEntity,
  entityId: string,
): Promise<PartnerActivity[]> {
  await requirePartner();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("activity")
    .select(
      `id, activityType, subject, description, outcome, status, dueAt, completedAt, createdAt,
       toAddress, sentAt, openedAt, clickedAt, bouncedAt, unsubscribedAt,
       owner:app_user!activity_ownerUserId_fkey ( fullName )`,
    )
    .eq("relatedEntityType", entityType)
    .eq("relatedEntityId", entityId)
    .is("deletedAt", null)
    .order("createdAt", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not load the activity: ${error.message}`);
  return (data ?? []).map((a) => ({ ...a, owner: one(a.owner as never) })) as unknown as PartnerActivity[];
}

const activitySchema = z.object({
  activityType: z.enum(["LOG", "CALL", "MEETING", "TASK"]),
  subject: z.string().trim().min(1, "Say what it was about.").max(255),
  description: z.string().trim().max(8000).optional().or(z.literal("")),
  outcome: z.string().trim().max(4000).optional().or(z.literal("")),
  dueAt: z.string().trim().optional().or(z.literal("")),
});

export async function logPartnerActivity(
  entityType: PartnerActivityEntity,
  entityId: string,
  input: z.infer<typeof activitySchema>,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const parsed = activitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  if (parsed.data.activityType === "TASK" && !parsed.data.dueAt) {
    return { ok: false, error: "A follow-up needs a date.", fieldErrors: { dueAt: ["When should it be done?"] } };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_log_activity", {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_activity: parsed.data,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data as { id: string } };
}

export async function closePartnerActivity(
  id: string,
  status: "COMPLETED" | "CANCELLED",
): Promise<ActionResult> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const db = await supabaseServer();
  const { error } = await db.rpc("partner_close_activity", { p_id: id, p_status: status });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const emailSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1, "Choose at least one lead to email."),
  subject: z.string().trim().min(1, "The email needs a subject.").max(300),
  bodyText: z.string().trim().min(1, "The email needs a message.").max(20000),
});

/**
 * Email some of the partner's leads.
 *
 * It goes from our sending address - the only one the provider will deliver
 * for - under the partner's name, with replies going to the partner. The leads
 * are read under the partner's own session, so a lead id that is not theirs
 * simply is not found; only then is the service client used, to write the
 * batch and its activities, which partners hold no policy to write.
 */
export async function sendPartnerLeadEmail(
  input: z.infer<typeof emailSchema>,
): Promise<ActionResult<SendResult>> {
  let user;
  try {
    user = await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the email.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const [{ data: leads, error }, { data: partner }] = await Promise.all([
    db.from("lead")
      .select("id, firstName, lastName, companyName, email")
      .in("id", d.leadIds)
      .is("deletedAt", null),
    db.from("partner").select("displayName, email, status").eq("id", user.partnerId!).maybeSingle(),
  ]);
  if (error) return { ok: false, error: error.message };
  if (!partner || partner.status !== "ACTIVE") {
    return { ok: false, error: "Only an active partnership can send email. Please speak to your partner manager." };
  }

  const result = await prepareLeadEmails({
    leads: leads ?? [],
    subject: d.subject,
    bodyText: d.bodyText,
    fromName: `${partner.displayName} via BabulTech`,
    replyTo: (partner.email as string | null) ?? user.email,
    sentById: user.id,
    db: supabaseAdmin(),
  });

  if (result.ok) {
    await queueJob({
      jobType: "lead_email",
      title: `Partner email: ${d.subject}`,
      payload: { batchId: result.data.batchId },
      progressTotal: result.data.queued,
      createdById: user.id,
    });
    revalidatePath("/portal/leads");
  }
  return result;
}

// ---------------------------------------------------------------------------
// The form's choices
// ---------------------------------------------------------------------------

export type PartnerPicklistKey = "industry" | "business_type" | "company_size" | "lead_source" | "lead_rating";
export type PartnerPicklists = Record<PartnerPicklistKey, { value: string; label: string }[]>;

/** The same lists our team's lead form offers, read-only. */
export async function getPartnerLeadPicklists(): Promise<PartnerPicklists> {
  await requirePartner();
  const keys: PartnerPicklistKey[] = ["industry", "business_type", "company_size", "lead_source", "lead_rating"];
  const db = await supabaseServer();
  const { data } = await db
    .from("picklist_value")
    .select("picklistKey, value, label")
    .in("picklistKey", keys)
    .eq("active", true)
    .order("sortOrder")
    .order("label");

  const lists = Object.fromEntries(keys.map((k) => [k, []])) as unknown as PartnerPicklists;
  for (const v of data ?? []) {
    lists[v.picklistKey as PartnerPicklistKey]?.push({ value: v.value as string, label: v.label as string });
  }
  // A list nobody has filled in still offers the usual answers.
  if (!lists.lead_rating.length) {
    lists.lead_rating = ["HOT", "WARM", "COLD"].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }));
  }
  return lists;
}
