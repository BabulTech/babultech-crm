"use server";

import { deleteToRecycleBin } from "./recycle-bin";
import { describeInvalid } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { LIST_LIMIT } from "@/lib/db";
import { picklistCode } from "@/lib/picklists";
import type { ActionResult } from "./partners";
import type { DuplicateField } from "@/lib/duplicates";

/**
 * Campaign members: the people marketing talks to.
 *
 * A member belongs to the campaign that produced them - the webinar they came
 * to, the form they filled in - so one person on two lists is two rows. That is
 * deliberate: it keeps the fact that they came from both places, which a single
 * global record would lose. They meet again at conversion: a member who is
 * already a lead is linked to that lead rather than made into a second one, so
 * the one lead is credited to both campaigns.
 *
 * Consent does not wait for that merge. It is keyed on the address, in
 * email_suppression, so one unsubscribe stops mail to every copy at once.
 *
 * Gated on lead:read and lead:write throughout. A campaign member is a prospect
 * who has not become a lead yet, and the people who work leads are the people
 * who should see them.
 */

export interface CampaignMember {
  id: string;
  campaignId: string | null;
  campaign?: { id: string; name: string } | null;
  jobTitle: string | null;
  leadId: string | null;
  /** Set when conversion found the person already a customer's contact, and linked them. */
  contactId: string | null;
  convertedAt: string | null;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  companyName: string | null;
  website: string | null;
  businessType: string | null;
  companySize: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  lastCampaignRunAt: string | null;
  lastCampaignId: string | null;
  campaignCount: number;
  emailOptOut: boolean;
  emailBounced: boolean;
  source: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  lastCampaign?: { name: string } | null;
  owner?: { fullName: string } | null;
}

const SELECT = `
  id, campaignId, jobTitle, leadId, contactId, convertedAt,
  firstName, lastName, email, phone, whatsapp, companyName, website,
  businessType, companySize, street, city, state, postalCode, country,
  lastCampaignRunAt, lastCampaignId, campaignCount, emailOptOut, emailBounced,
  source, notes, active, createdAt,
  campaign:campaign!campaign_member_campaignId_fkey ( id, name ),
  lastCampaign:campaign!campaign_member_lastCampaignId_fkey ( name ),
  owner:app_user!campaign_member_ownerUserId_fkey ( fullName )
`;

export interface MemberFilters {
  /** Matches a name, company or email. */
  search?: string;
  businessType?: string;
  companySize?: string;
  /** Leave out anyone who has unsubscribed or whose address bounced. */
  contactableOnly?: boolean;
  /** Only people no campaign has touched since this date. */
  notContactedSince?: string;
  /** The campaign that produced them. */
  campaignId?: string;
  source?: string;
  /** "yes" or "no" — whether they have been turned into a lead. */
  converted?: string;
}

export async function listCampaignMembers(filters: MemberFilters = {}): Promise<CampaignMember[]> {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  let query = db.from("campaign_member").select(SELECT).is("deletedAt", null);

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    query = query.or(
      `firstName.ilike.${term},lastName.ilike.${term},companyName.ilike.${term},email.ilike.${term}`,
    );
  }
  if (filters.campaignId) query = query.eq("campaignId", filters.campaignId);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.converted === "yes") query = query.not("convertedAt", "is", null);
  if (filters.converted === "no") query = query.is("convertedAt", null);
  if (filters.businessType) query = query.eq("businessType", filters.businessType);
  if (filters.companySize) query = query.eq("companySize", filters.companySize);
  if (filters.contactableOnly) {
    query = query.eq("emailOptOut", false).eq("emailBounced", false).eq("active", true);
  }
  if (filters.notContactedSince) {
    // Somebody never contacted has a null date, and null is not "before" a
    // date in SQL — so they have to be asked for explicitly or the people most
    // worth mailing drop out of the list.
    query = query.or(
      `lastCampaignRunAt.is.null,lastCampaignRunAt.lt.${filters.notContactedSince}`,
    );
  }

  const { data, error } = await query
    .order("createdAt", { ascending: false })
    .limit(LIST_LIMIT);

  if (error) throw new Error(`Could not load campaign members: ${error.message}`);
  return (data ?? []) as unknown as CampaignMember[];
}

export async function getCampaignMember(id: string): Promise<CampaignMember | null> {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("campaign_member")
    .select(SELECT)
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load the member: ${error.message}`);
  return (data as unknown as CampaignMember) ?? null;
}

const memberSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  campaignId: z.string().uuid("Choose the campaign this person came from.").optional().or(z.literal("")),
  firstName: z.string().trim().min(1, "A member needs a first name.").max(100),
  jobTitle: z.string().trim().max(150).optional().or(z.literal("")),
  lastName: z.string().trim().max(100).optional().or(z.literal("")),
  email: z.string().trim().email("That does not look like an email address.").optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  whatsapp: z.string().trim().max(50).optional().or(z.literal("")),
  companyName: z.string().trim().max(200).optional().or(z.literal("")),
  website: z.string().trim().max(255).optional().or(z.literal("")),
  businessType: picklistCode.optional().or(z.literal("")),
  companySize: picklistCode.optional().or(z.literal("")),
  street: z.string().trim().max(255).optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
  state: z.string().trim().max(100).optional().or(z.literal("")),
  postalCode: z.string().trim().max(30).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  source: picklistCode.optional().or(z.literal("")),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
  active: z.coerce.boolean().default(true),
});

/** Empty strings become null, so a cleared field is cleared rather than blank. */
function nullable(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export async function saveCampaignMember(
  input: z.infer<typeof memberSchema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = memberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const row = {
    campaignId: nullable(d.campaignId),
    firstName: d.firstName,
    jobTitle: nullable(d.jobTitle),
    lastName: nullable(d.lastName),
    email: nullable(d.email)?.toLowerCase() ?? null,
    phone: nullable(d.phone),
    whatsapp: nullable(d.whatsapp),
    companyName: nullable(d.companyName),
    website: nullable(d.website),
    businessType: nullable(d.businessType),
    companySize: nullable(d.companySize),
    street: nullable(d.street),
    city: nullable(d.city),
    state: nullable(d.state),
    postalCode: nullable(d.postalCode),
    country: nullable(d.country),
    source: nullable(d.source),
    notes: nullable(d.notes),
    active: d.active,
    updatedAt: new Date().toISOString(),
  };

  const db = await supabaseServer();

  // The unique index would catch this, but its error message is a constraint
  // name. Saying whose address it is lets them go and find the person.
  //
  // Scoped to the campaign, matching the index: the same address in a DIFFERENT
  // campaign is a second real event, not a mistake, and refusing it here would
  // undo the point of the redesign.
  if (row.email) {
    let clash = db
      .from("campaign_member")
      .select("id, firstName, lastName")
      .eq("email", row.email)
      .is("deletedAt", null);
    clash = row.campaignId
      ? clash.eq("campaignId", row.campaignId)
      : clash.is("campaignId", null);
    if (d.id) clash = clash.neq("id", d.id);

    const { data: existing } = await clash.maybeSingle();
    if (existing) {
      return {
        ok: false,
        error: `${existing.firstName} ${existing.lastName ?? ""}`.trim() +
          ` is already on this campaign with ${row.email}.`,
        fieldErrors: { email: ["Already on this campaign."] },
      };
    }
  }

  const { data, error } = d.id
    ? await db.from("campaign_member").update(row).eq("id", d.id).select("id").maybeSingle()
    : await db
        .from("campaign_member")
        .insert({ id: randomUUID(), ownerUserId: auth.user.id, ...row })
        .select("id")
        .single();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That member no longer exists." };

  revalidatePath("/campaign-members");
  return { ok: true, data: { id: data.id as string } };
}

/** Soft delete, as everywhere else — the campaigns they were in still ran. */
/** Only the Super Admin deletes; this is the recycle bin's delete, kept for its callers. */
export async function deleteCampaignMember(id: string, reason?: string | null): Promise<ActionResult> {
  return deleteToRecycleBin("CampaignMember", id, reason) as never;
}

/**
 * Unsubscribe somebody, by hand.
 *
 * Separate from an ordinary edit because it is not an ordinary edit: it applies
 * to every campaign, for good, and the date it happened is the evidence that we
 * honoured it. The public unsubscribe link will call the same path.
 */
export async function setEmailOptOut(
  id: string,
  optOut: boolean,
  reason?: string,
): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { error } = await db
    .from("campaign_member")
    .update({
      emailOptOut: optOut,
      emailOptOutAt: optOut ? new Date().toISOString() : null,
      emailOptOutReason: optOut ? (reason?.trim() || "Asked to be removed") : null,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/campaign-members");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const importRowSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  whatsapp: z.string().trim().optional(),
  companyName: z.string().trim().optional(),
  website: z.string().trim().optional(),
  businessType: z.string().trim().optional(),
  companySize: z.string().trim().optional(),
  street: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  postalCode: z.string().trim().optional(),
  country: z.string().trim().optional(),
  source: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Import a list, matching on email.
 *
 * A known address updates what it can and leaves the rest; an unknown one is
 * added. Lists are bought, exported and re-exported, so the same people arrive
 * again and again — an import that only ever inserted would fill the table with
 * duplicates by the third file.
 */
export async function importCampaignMembers(
  rows: z.infer<typeof importRowSchema>[],
): Promise<ActionResult<ImportSummary>> {
  const auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "There is nothing in that file." };
  }
  if (rows.length > 5000) {
    return { ok: false, error: `That file has ${rows.length} rows. Import up to 5,000 at a time.` };
  }

  const clean = rows.filter((r) => (r?.firstName ?? "").trim() !== "");
  if (clean.length === 0) {
    return { ok: false, error: "No row in that file has a first name." };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("import_campaign_members", {
    p_rows: clean,
    p_owner: auth.user.id,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/campaign-members");
  const summary = (typeof data === "string" ? JSON.parse(data) : data) as ImportSummary;
  return { ok: true, data: { ...summary, skipped: summary.skipped + (rows.length - clean.length) } };
}

/** Totals for the list header. */
export async function getCampaignMemberTotals() {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  const [total, contactable, optedOut, untouched] = await Promise.all([
    db.from("campaign_member").select("id", { count: "exact", head: true }).is("deletedAt", null),
    db
      .from("campaign_member")
      .select("id", { count: "exact", head: true })
      .is("deletedAt", null)
      .eq("emailOptOut", false)
      .eq("emailBounced", false)
      .eq("active", true)
      .not("email", "is", null),
    db
      .from("campaign_member")
      .select("id", { count: "exact", head: true })
      .is("deletedAt", null)
      .eq("emailOptOut", true),
    db
      .from("campaign_member")
      .select("id", { count: "exact", head: true })
      .is("deletedAt", null)
      .is("lastCampaignRunAt", null),
  ]);

  return {
    total: total.count ?? 0,
    contactable: contactable.count ?? 0,
    optedOut: optedOut.count ?? 0,
    neverContacted: untouched.count ?? 0,
  };
}

/** What converting a member did. */
export interface MemberConversion {
  /** The lead the member is now, whether made just now or found. */
  leadId?: string | null;
  leadNumber?: string | null;
  /** The contact the member was linked to, when they were already a customer's contact. */
  contactId?: string | null;
  alreadyConverted: boolean;
  /** True when the person was already on file and the member was linked rather than converted. */
  linked?: boolean;
  name?: string | null;
  company?: string | null;
  /** Which of the member's details matched the record they were linked to. */
  matchedOn?: DuplicateField | null;
}

/**
 * Turn a campaign member into a lead.
 *
 * All the work is in convert_member_to_lead(), in the database, because it has
 * to allocate a lead number and write to two tables and an audit row as one
 * act - split across calls, a failure between them burns a number or leaves a
 * member pointing at a lead that does not exist.
 *
 * Somebody already on file is not made into a second lead: the member is linked
 * to the lead they already are, or to their contact if they are a customer, and
 * the caller is told so.
 *
 * Idempotent: the function returns the existing lead rather than making a second
 * one, so a double-click is harmless and the caller is told which happened.
 */
export async function convertMemberToLead(
  memberId: string,
  ownerUserId?: string,
): Promise<ActionResult<MemberConversion>> {
  const auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { data, error } = await db.rpc("convert_member_to_lead", {
    p_member_id: memberId,
    p_owner_id: ownerUserId ?? null,
  });

  if (error) return { ok: false, error: error.message };

  const result = data as MemberConversion;

  revalidatePath("/campaign-members");
  revalidatePath(`/campaign-members/${memberId}`);
  revalidatePath("/leads");
  if (result.leadId) revalidatePath(`/leads/${result.leadId}`);
  if (result.contactId) revalidatePath(`/contacts/${result.contactId}`);
  return { ok: true, data: result };
}
