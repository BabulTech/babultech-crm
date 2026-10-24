"use server";

import { getProductOptions } from "./product-options";
import { describeInvalid } from "@/lib/form-errors";
import { optionKey } from "@/lib/product-options";
import { randomUUID } from "node:crypto";
import { withRateSnapshots } from "@/lib/rate-snapshots";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { picklistCode } from "@/lib/picklists";
import { supabaseServer } from "@/lib/supabase";
import { createRecord, updateRecord, applyScopeWithPartners, applySearch, LIST_LIMIT } from "@/lib/db";
import { one, toDecimal } from "@/lib/decimal";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, requirePermission, requireUser, scopedContext, can, canAny, AuthorizationError } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import { MESSAGE_CHANNELS } from "@/lib/types";
import type { ActionResult } from "./partners";
import {
  DUPLICATE_FIELD_LABEL, describeDuplicate, duplicateFailure, duplicateFromError, duplicateRef,
  emailKey, phoneKey, type DuplicateField, type DuplicateMatch, type DuplicateRef,
} from "@/lib/duplicates";

/** Accounts, Contacts, Leads, Campaigns and Products — the Phase 1 core. */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const accountSchema = z.object({
  name: z.string().min(1).max(200),
  accountType: picklistCode.default("PROSPECT"),
  customerStatus: z.enum(["ONBOARDING", "ACTIVE", "AT_RISK", "CHURNED"]).optional().nullable(),
  parentAccountId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid(),
  industry: z.string().max(100).optional().nullable(),
  website: z.string().max(255).optional().nullable(),
  mainPhone: z.string().max(50).optional().nullable(),
  taxNumberNtn: z.string().max(50).optional().nullable(),
  creditLimit: z.coerce.number().min(0).optional().nullable(),
  paymentTermsDays: z.coerce.number().int().min(0).optional().nullable(),
  customerHealth: z.enum(["GREEN", "AMBER", "RED"]).optional().nullable(),
  description: z.string().optional().nullable(),
  billingAddress: z.record(z.string()).optional().nullable(),
});

export async function createAccount(
  input: z.infer<typeof accountSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.ACCOUNT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const account = await createRecord<{ id: string }>(
      "account",
      { ...parsed.data, billingAddress: parsed.data.billingAddress ?? null },
      { field: "accountNumber", sequence: SEQUENCES.ACCOUNT },
    );

    revalidatePath("/accounts");
    return { ok: true, data: { id: account.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the account." };
  }
}

export async function updateAccount(
  id: string,
  input: z.infer<typeof accountSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.ACCOUNT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    // update_record reads, updates and writes the change history in one
    // transaction — see supabase/functions-sql/014_fn_generic_write.sql.
    await updateRecord(
      "account",
      id,
      { ...parsed.data, billingAddress: parsed.data.billingAddress ?? null },
      "Account",
      user.id,
    );

    revalidatePath("/accounts");
    revalidatePath(`/accounts/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the account." };
  }
}

export async function listAccounts(filters?: {
  search?: string;
  accountType?: string;
  /** The partner who brought the account to us. */
  partnerId?: string;
}) {
  const { where } = await scopedContext("ownerUserId");

  const db = await supabaseServer();

  let query = db
    .from("account")
    .select(
      `*,
       owner:app_user!account_ownerUserId_fkey ( id, fullName ),
       partner!partner_accountId_fkey ( id, partnerNumber, partnerType, tier ),
       sourcePartner:partner!account_sourcePartnerId_fkey ( id, displayName ),
       contacts:contact ( count ),
       opportunities:opportunity ( count ),
       cases:support_case ( count ),
       projects:project ( count )`,
    )
    .is("deletedAt", null)
    .order("name", { ascending: true });

  // Our own by scope, and every partner's.
  query = applyScopeWithPartners(query, where, "sourcePartnerId");

  if (filters?.accountType) query = query.eq("accountType", filters.accountType);
  if (filters?.partnerId) query = query.eq("sourcePartnerId", filters.partnerId);
  if (filters?.search) {
    // PostgREST's or() takes a comma-separated filter list; ilike with %
    // wildcards is Prisma's `contains` + `mode: "insensitive"`.
    const s = filters.search.replace(/[,()]/g, "");
    query = query.or(`name.ilike.%${s}%,accountNumber.ilike.%${s}%`);
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load accounts: ${error.message}`);

  // Reshape PostgREST's aggregate relations into the _count shape pages read.
  // Reshape PostgREST's aggregate relations into the _count shape pages read,
  // keeping the account's own columns on the result.
  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;

  return (data ?? []).map((row) => ({
    ...row,
    owner: one(row.owner as never),
    partner: one(row.partner as never),
    sourcePartner: one(row.sourcePartner as never) as { id: string; displayName: string } | null,
    _count: {
      contacts: countOf(row.contacts),
      opportunities: countOf(row.opportunities),
      cases: countOf(row.cases),
      projects: countOf(row.projects),
    },
  }));
}

export async function getAccount(id: string) {
  await requirePermission(PERMISSIONS.ACCOUNT_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("account")
    .select(
      `*,
       owner:app_user!account_ownerUserId_fkey ( id, fullName, email ),
       parentAccount:parentAccountId ( id, name ),
       partner!partner_accountId_fkey ( * ),
       sourcePartner:partner!account_sourcePartnerId_fkey ( id, displayName, partnerNumber ),
       contacts:contact ( * ),
       opportunities:opportunity ( id, opportunityNumber, name, stage, amount, currencyCode, expectedCloseDate, deletedAt ),
       contracts:contract ( *, deletedAt ),
       cases:support_case ( id, caseNumber, subject, status, priority, createdAt, deletedAt ),
       projects:project ( id, projectNumber, name, status, health, deletedAt ),
       invoices:invoice ( id, invoiceNumber, totalAmount, outstandingAmount, dueDate, status, currencyCode, invoiceDate, deletedAt )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load account: ${error.message}`);
  if (!data) return null;

  // PostgREST cannot embed the reverse side of a self-referencing FK
  // (account.parentAccountId -> account.id), so children are a second query.
  const { data: childAccounts } = await db
    .from("account")
    .select("id, name, accountType")
    .eq("parentAccountId", id)
    .is("deletedAt", null);

  // PostgREST returns embedded collections unfiltered and unordered, so the
  // per-relation where/orderBy/take from the Prisma query are applied here.
  // Rows come back from PostgREST untyped; these helpers keep the shape the
  // pages index into rather than collapsing it to never.
  type Row = Record<string, unknown>;

  const live = (rows: unknown): Row[] =>
    ((rows as Row[] | null) ?? []).filter((r) => !r.deletedAt);

  const byDesc = (rows: Row[], key: string): Row[] =>
    rows
      .slice()
      .sort((a, b) => String(b[key] ?? "").localeCompare(String(a[key] ?? "")));

  const contacts = live(data.contacts as { deletedAt?: unknown; isPrimary?: boolean; lastName?: string }[]).sort(
    (a, b) =>
      Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false) ||
      String(a.lastName ?? "").localeCompare(String(b.lastName ?? "")),
  );

  return {
    ...data,
    owner: one(data.owner as never),
    parentAccount: one(data.parentAccount as never),
    childAccounts: childAccounts ?? [],
    partner: one(data.partner as never),
    contacts,
    opportunities: byDesc(live(data.opportunities), "expectedCloseDate").slice(0, 20),
    contracts: byDesc(live(data.contracts), "endDate" as never).slice(0, 10),
    cases: byDesc(live(data.cases), "createdAt").slice(0, 10),
    projects: live(data.projects),
    invoices: byDesc(
      live(data.invoices).filter(
        (i) => !["DRAFT", "CANCELLED"].includes((i as { status?: string }).status ?? ""),
      ),
      "invoiceDate",
    ).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const contactSchema = z.object({
  /** Nullable — an individual partner or private person has no employer. */
  accountId: z.string().uuid().optional().nullable(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  jobTitle: z.string().max(150).optional().nullable(),
  department: z.string().max(100).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  mobile: z.string().max(50).optional().nullable(),
  whatsapp: z.string().max(50).optional().nullable(),
  contactRole: z.string().max(100).optional().nullable(),
  isPrimary: z.boolean().default(false),
  preferredChannel: picklistCode.optional().nullable(),
  communicationConsent: z.boolean().default(false),
});

export async function createContact(
  input: z.infer<typeof contactSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.ACCOUNT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    // create_contact demotes any existing primary and inserts in one
    // transaction — see supabase/functions-sql/015_fn_contact_primary.sql.
    const db = await supabaseServer();
    const { data: contact, error } = await db.rpc("create_contact", {
      p_payload: { ...data, accountId: data.accountId ?? null, email: data.email || null },
    });
    if (error) return duplicateFailure(error) ?? { ok: false, error: error.message };

    revalidatePath("/contacts");
    if (data.accountId) revalidatePath(`/accounts/${data.accountId}`);
    return { ok: true, data: { id: contact.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the contact." };
  }
}

export async function getContact(id: string) {
  await requirePermission(PERMISSIONS.ACCOUNT_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("contact")
    .select(
      `*,
       account ( id, name ),
       partnerAsPerson:partner!partner_contactId_fkey ( id, partnerNumber )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load contact: ${error.message}`);
  if (!data) return null;

  return {
    ...data,
    account: one(data.account as never),
    partnerAsPerson: one(data.partnerAsPerson as never),
  };
}

export async function updateContact(
  id: string,
  input: z.infer<typeof contactSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.ACCOUNT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    // A contact that backs an individual partner must keep accountId null —
    // the partner_identity_check constraint depends on it. Checked before the
    // write rather than inside it, so the user gets this message rather than a
    // raw constraint violation.
    const { data: isPartnerPerson } = await db
      .from("partner")
      .select("id")
      .eq("contactId", id)
      .is("deletedAt", null)
      .limit(1)
      .maybeSingle();

    if (isPartnerPerson && data.accountId) {
      return {
        ok: false,
        error:
          "This contact is an individual partner and cannot be attached to a company account.",
      };
    }

    // Demote-other-primaries + update + audit, atomically.
    const { error } = await db.rpc("update_contact", {
      p_id: id,
      p_payload: { ...data, accountId: data.accountId ?? null, email: data.email || null },
      p_actor_id: user.id,
    });
    if (error) return duplicateFailure(error) ?? { ok: false, error: error.message };

    revalidatePath("/contacts");
    if (data.accountId) revalidatePath(`/accounts/${data.accountId}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the contact." };
  }
}

export async function listContacts(filters?: { search?: string; accountId?: string; unaffiliatedOnly?: boolean }) {
  await requirePermission(PERMISSIONS.ACCOUNT_READ);

  const db = await supabaseServer();

  let query = db
    .from("contact")
    .select(
      `*,
       account ( id, name ),
       partnerAsPerson:partner!partner_contactId_fkey ( id, partnerNumber, partnerType )`,
    )
    .is("deletedAt", null)
    .order("lastName")
    .order("firstName");

  if (filters?.accountId) query = query.eq("accountId", filters.accountId);
  if (filters?.unaffiliatedOnly) query = query.is("accountId", null);
  if (filters?.search) {
    const s = filters.search.replace(/[,()]/g, "");
    query = query.or(
      `firstName.ilike.%${s}%,lastName.ilike.%${s}%,email.ilike.%${s}%`,
    );
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load contacts: ${error.message}`);

  return (data ?? []).map((c) => ({
    ...c,
    account: one(c.account as never),
    partnerAsPerson: one(c.partnerAsPerson as never),
  }));
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const leadSchema = z.object({
  // What this lead becomes if it converts: a customer, or a partner. It is
  // read by convert_lead to decide the account's type, so it is a real
  // branch rather than a label.
  leadType: z.enum(["SALES", "PARTNER"]).default("SALES"),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  companyName: z.string().max(200).optional().nullable(),
  jobTitle: z.string().max(150).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  whatsapp: z.string().max(50).optional().nullable(),
  industry: z.string().max(100).optional().nullable(),
  // Carried over from a campaign member on conversion, and editable after.
  // Without these, converting a trade-show record dropped the company details
  // and the whole address - often the only useful thing on it.
  website: z.string().max(255).optional().nullable(),
  businessType: picklistCode.optional().nullable().or(z.literal("")),
  companySize: picklistCode.optional().nullable().or(z.literal("")),
  street: z.string().max(255).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(30).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  leadSource: z.string().max(100).optional().nullable(),
  campaignId: z.string().uuid().optional().nullable(),
  /** Credits a partner for the referral — carries through to the opportunity. */
  referredByPartnerId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid(),
  // Prospecting: from a list such as Google Maps, before anyone is spoken to.
  icpTier: z.string().max(60).optional().nullable(),
  googleRating: z.coerce.number().min(0).max(5).optional().nullable(),
  googleReviewCount: z.coerce.number().int().min(0).optional().nullable(),
  googleMapsUrl: z.string().url().max(2000).optional().nullable().or(z.literal("")),
  phoneClass: z.string().max(60).optional().nullable(),
  phoneType: z.string().max(60).optional().nullable(),
  region: z.string().max(120).optional().nullable(),
  leadList: z.string().max(120).optional().nullable(),
  rating: picklistCode.optional().nullable(),
  estimatedValue: z.coerce.number().min(0).optional().nullable(),
  description: z.string().optional().nullable(),
  nextFollowUpAt: z.coerce.date().optional().nullable(),
});

/** A row the import left out, and why - shown to the person who imported it. */
export interface LeadImportSkip {
  /** 1-based, as the rows are numbered on the import screen. */
  row: number;
  name: string;
  reason: string;
  duplicate?: DuplicateRef;
}

/**
 * Imports many leads at once, from a mapped spreadsheet.
 *
 * Rows arrive already mapped to lead fields by the import screen, so this does
 * not know or care what the source columns were called. What it does is
 * validate every row before writing any of them: a half-finished import leaves
 * someone reconciling which prospects already exist, which is worse than a
 * rejected paste they can fix and retry.
 *
 * People already in the CRM - as a lead or a contact - and people repeated
 * further down the same file are skipped, not refused. The duplicate rule would
 * stop each of them anyway, and stopping the whole file for them would mean a
 * list could never be imported twice. What was skipped comes back, row by row.
 */
export async function createLeadsBulk(
  rows: z.infer<typeof leadSchema>[],
): Promise<ActionResult<{ created: number; skipped: LeadImportSkip[] }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  if (!rows.length) return { ok: false, error: "No rows to import." };
  if (rows.length > 500) {
    return { ok: false, error: "Import at most 500 rows at a time." };
  }

  const validated: z.infer<typeof leadSchema>[] = [];
  const rowErrors: string[] = [];

  rows.forEach((row, i) => {
    const parsed = leadSchema.safeParse(row);
    if (!parsed.success) {
      const first = Object.entries(parsed.error.flatten().fieldErrors)[0];
      rowErrors.push(
        `Row ${i + 1}: ${first ? `${first[0]}, ${first[1]?.[0]}` : "invalid"}`,
      );
      return;
    }
    validated.push(parsed.data);
  });

  if (rowErrors.length) {
    return { ok: false, error: rowErrors.slice(0, 10).join("\n") };
  }

  // Every row checked in one call. validated lines up with rows, because any
  // invalid row has already stopped the import.
  const db = await supabaseServer();
  const { data: hits, error: checkError } = await db.rpc("find_duplicate_people", {
    p_scope: "lead",
    p_rows: validated.map((d) => ({
      email: d.email || null,
      phone: d.phone || null,
      whatsapp: d.whatsapp || null,
    })),
  });
  if (checkError) {
    return { ok: false, error: `Could not check for people already on file: ${checkError.message}` };
  }
  const onFile = new Map(((hits ?? []) as DuplicateMatch[]).map((h) => [h.row, h]));

  const skipped: LeadImportSkip[] = [];
  const toCreate: { row: number; lead: z.infer<typeof leadSchema> }[] = [];
  // The first row of this file to carry each address or number. Numbers share
  // one key space, so a WhatsApp number repeats an earlier row's phone number.
  const firstRowWith = new Map<string, number>();

  validated.forEach((d, i) => {
    const row = i + 1;
    const name = `${d.firstName} ${d.lastName}`.trim();

    const match = onFile.get(i);
    if (match) {
      skipped.push({ row, name, reason: describeDuplicate(match), duplicate: duplicateRef(match) });
      return;
    }

    const email = emailKey(d.email);
    const phone = phoneKey(d.phone);
    const whatsapp = phoneKey(d.whatsapp);
    const keys: { field: DuplicateField; key: string }[] = [];
    if (email) keys.push({ field: "email", key: `e:${email}` });
    if (phone) keys.push({ field: "phone", key: `p:${phone}` });
    if (whatsapp) keys.push({ field: "whatsapp", key: `p:${whatsapp}` });

    const repeat = keys.find((k) => firstRowWith.has(k.key));
    if (repeat) {
      skipped.push({
        row, name,
        reason: `Same ${DUPLICATE_FIELD_LABEL[repeat.field]} as row ${firstRowWith.get(repeat.key)} of this file`,
      });
      return;
    }
    for (const k of keys) firstRowWith.set(k.key, row);
    toCreate.push({ row, lead: d });
  });

  let created = 0;
  // Sequential, because leadNumber comes from a sequence that hands out one
  // number at a time.
  for (const { row, lead: d } of toCreate) {
    try {
      await createRecord(
        "lead",
        {
          firstName: d.firstName,
          lastName: d.lastName,
          companyName: d.companyName || null,
          jobTitle: d.jobTitle || null,
          email: d.email || null,
          phone: d.phone || null,
          whatsapp: d.whatsapp || null,
          industry: d.industry || null,
          leadSource: d.leadSource || null,
          campaignId: d.campaignId || null,
          referredByPartnerId: d.referredByPartnerId || null,
          ownerUserId: d.ownerUserId,
          rating: d.rating || null,
          estimatedValue: d.estimatedValue ?? null,
          description: d.description || null,
          nextFollowUpAt: d.nextFollowUpAt ?? null,
          status: "NEW",
        },
        { field: "leadNumber", sequence: SEQUENCES.LEAD },
      );
      created += 1;
    } catch (err) {
      // Somebody added the same person while the file was being imported.
      const match = duplicateFromError(err);
      if (match) {
        skipped.push({
          row, name: `${d.firstName} ${d.lastName}`.trim(),
          reason: describeDuplicate(match), duplicate: duplicateRef(match),
        });
        continue;
      }
      return {
        ok: false,
        error:
          `${created} of ${toCreate.length} rows were created before this failed: ` +
          (err instanceof Error ? err.message : "unknown error"),
      };
    }
  }

  if (created > 0) revalidatePath("/leads");
  skipped.sort((a, b) => a.row - b.row);
  return { ok: true, data: { created, skipped } };
}

export async function createLead(
  input: z.infer<typeof leadSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const lead = await createRecord<{ id: string }>(
      "lead",
      { ...parsed.data, email: parsed.data.email || null, googleMapsUrl: parsed.data.googleMapsUrl || null },
      { field: "leadNumber", sequence: SEQUENCES.LEAD },
    );

    revalidatePath("/leads");
    return { ok: true, data: { id: lead.id } };
  } catch (err) {
    return duplicateFailure(err)
      ?? { ok: false, error: err instanceof Error ? err.message : "Could not create the lead." };
  }
}

export async function getLead(id: string) {
  await requirePermission(PERMISSIONS.LEAD_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("lead")
    .select(
      `*,
       owner:app_user!lead_ownerUserId_fkey ( id, fullName ),
       campaign:campaign!lead_campaignId_fkey ( id, name ),
       referredByPartner:partner ( id, displayName ),
       convertedAccount:account ( id, name ),
       convertedOpportunity:opportunity ( id, name )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load lead: ${error.message}`);
  if (!data) return null;

  return {
    ...data,
    owner: one(data.owner as never),
    campaign: one(data.campaign as never),
    referredByPartner: one(data.referredByPartner as never),
    convertedAccount: one(data.convertedAccount as never),
    convertedOpportunity: one(data.convertedOpportunity as never),
  };
}

const leadUpdateSchema = leadSchema.extend({
  status: z.enum([
    "PROSPECT", "NEW", "ASSIGNED", "ATTEMPTED_CONTACT", "CONTACTED", "DISCOVERY_SCHEDULED",
    "QUALIFIED", "NURTURING", "DISQUALIFIED",
    // Only ever kept, on a converted lead being corrected; converting is its own step.
    "CONVERTED",
  ]),
  disqualifiedReason: z.string().max(255).optional().nullable(),
});

export async function updateLead(
  id: string,
  input: z.infer<typeof leadUpdateSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = leadUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.status === "DISQUALIFIED" && !data.disqualifiedReason) {
    return {
      ok: false,
      error: "A reason is required to disqualify a lead.",
      fieldErrors: { disqualifiedReason: ["Tell us why this lead was disqualified."] },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("lead")
      .select("status, leadNumber")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Lead not found." };

    // Spec §13: a converted lead is read-only - to everyone but an
    // administrator correcting it, who cannot un-convert it by editing.
    const gate = await editGate("Lead", id);
    if (!gate.ok) return { ok: false, error: gate.error };
    if (data.status === "CONVERTED" && before.status !== "CONVERTED") {
      return { ok: false, error: "Convert a lead with Convert, which creates its account, contact and deal.", fieldErrors: { status: ["Use Convert instead."] } };
    }

    const { error } = await db.rpc("update_record", {
      p_table: "lead",
      p_id: id,
      p_payload: {
        ...data,
        ...(before.status === "CONVERTED" ? { status: "CONVERTED" } : {}),
        email: data.email || null,
        googleMapsUrl: data.googleMapsUrl || null,
        disqualifiedReason:
          data.status === "DISQUALIFIED" ? data.disqualifiedReason : null,
      },
      p_entity_type: "Lead",
      p_actor_id: user.id,
    });
    if (error) return duplicateFailure(error) ?? { ok: false, error: error.message };
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/leads");
    revalidatePath(`/leads/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the lead." };
  }
}

const convertSchema = z.object({
  leadId: z.string().uuid(),
  /** Reuse an existing account instead of creating one. */
  accountId: z.string().uuid().optional().nullable(),
  createOpportunity: z.boolean().default(true),
  opportunityName: z.string().max(255).optional(),
  amount: z.coerce.number().min(0).optional(),
  expectedCloseDate: z.coerce.date().optional(),
});

/**
 * Lead conversion (spec §13): the lead becomes read-only and points at the
 * resulting Account and Contact; the Opportunity is optional. If the lead came
 * through a partner referral, the partner is credited on the account and the
 * deal, which is what gives the deal its partner commission record.
 */
export async function convertLead(
  input: z.infer<typeof convertSchema>,
): Promise<ActionResult<{
  accountId: string;
  contactId: string;
  opportunityId: string | null;
  /** The person was already a contact, and conversion used them rather than making another. */
  reusedContact: boolean;
}>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = convertSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    const { data: leadRow } = await db
      .from("lead")
      .select("status, leadNumber")
      .eq("id", data.leadId)
      .maybeSingle();

    if (!leadRow) return { ok: false, error: "Lead not found." };
    if (leadRow.status === "CONVERTED") {
      return { ok: false, error: `Lead ${leadRow.leadNumber} has already been converted.` };
    }

    // Five tables in one transaction — see supabase/functions-sql/016_fn_convert_lead.sql.
    const { data: result, error } = await db.rpc("convert_lead", {
      p_lead_id: data.leadId,
      p_actor_id: user.id,
      p_account_id: data.accountId ?? null,
      p_create_opportunity: data.createOpportunity,
      p_opportunity_name: data.opportunityName ?? null,
      p_amount: data.amount ?? null,
      p_expected_close: data.expectedCloseDate
        ? data.expectedCloseDate.toISOString().slice(0, 10)
        : null,
      // Kept in the signature for callers that still pass them; the
      // registration window they described no longer exists.
      p_registered_at: null,
      p_expires_at: null,
      p_protection_days: null,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/leads");
    revalidatePath("/accounts");
    revalidatePath("/opportunities");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not convert the lead." };
  }
}

/**
 * The contact a lead's person already is, if any.
 *
 * Converting such a lead uses that contact, on that contact's account, rather
 * than making a second one - so the convert screen asks first, and says so
 * before anything is written.
 */
export async function findLeadContactMatch(leadId: string): Promise<DuplicateMatch | null> {
  await requirePermission(PERMISSIONS.LEAD_WRITE);
  const db = await supabaseServer();

  const { data: lead } = await db
    .from("lead")
    .select("email, phone, whatsapp")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return null;

  const { data, error } = await db.rpc("find_duplicate_people", {
    p_scope: "contact",
    p_rows: [{ email: lead.email, phone: lead.phone, whatsapp: lead.whatsapp }],
  });
  if (error) throw new Error(`Could not look for an existing contact: ${error.message}`);
  return ((data ?? []) as DuplicateMatch[])[0] ?? null;
}

/** The values in use for the prospecting filters on the leads list. */
export async function getLeadFilterOptions() {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();
  const distinct = async (column: "icpTier" | "region" | "leadList") => {
    const { data } = await db.rpc("lead_distinct_values", { p_column: column });
    return ((data ?? []) as { value: string }[]).map((r) => r.value);
  };
  const [icpTiers, regions, leadLists] = await Promise.all([distinct("icpTier"), distinct("region"), distinct("leadList")]);
  return { icpTiers, regions, leadLists };
}

export interface LeadStats {
  total: number;
  open: number;
  converted: number;
  disqualified: number;
  estimatedValue: number;
  partnerRegistrations: number;
  awaitingReview: number;
  prospects: number;
  breakdown: Partial<Record<"status" | "icpTier" | "region" | "leadList", { value: string | null; count: number }[]>>;
}

/**
 * True figures for the leads page, counted in the database with the list's
 * filters. The list itself stops at LIST_LIMIT rows, so counting what it
 * loaded undercounted as soon as there were more leads than that.
 */
export async function getLeadStats(filters?: Record<string, string | undefined>): Promise<LeadStats> {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();
  const keys = ["search", "status", "source", "campaignId", "partnerId", "icpTier", "region", "leadList"] as const;
  const payload = Object.fromEntries(keys.filter((k) => filters?.[k]).map((k) => [k, filters![k]]));
  const { data, error } = await db.rpc("lead_stats", { p_filters: payload });
  if (error) throw new Error(`Could not count leads: ${error.message}`);
  const d = data as LeadStats;
  return { ...d, estimatedValue: Number(d.estimatedValue ?? 0) };
}

export async function listLeads(filters?: {
  search?: string;
  status?: string;
  source?: string;
  /** The campaign that produced the lead - how a campaign's audience is found. */
  campaignId?: string;
  /** The partner the lead is credited to. */
  partnerId?: string;
  /** Prospecting fields: how well they fit, where, and which list. */
  icpTier?: string;
  region?: string;
  leadList?: string;
}) {
  const { where } = await scopedContext("ownerUserId");

  const db = await supabaseServer();

  let query = db
    .from("lead")
    .select(
      `*,
       owner:app_user!lead_ownerUserId_fkey ( id, fullName ),
       campaign:campaign!lead_campaignId_fkey ( id, name ),
       referredByPartner:partner ( id, displayName )`,
    )
    .is("deletedAt", null)
    .order("createdAt", { ascending: false });

  // Our own by scope, and every partner's.
  query = applyScopeWithPartners(query, where, "referredByPartnerId");

  // Deals partners have registered through the portal, awaiting a decision.
  if (filters?.source === "partner") query = query.not("referredByPartnerId", "is", null);
  // Prospects are marketing's until someone qualifies them, so the lead list
  // leaves them out unless they are asked for.
  if (filters?.status) query = query.eq("status", filters.status);
  else query = query.neq("status", "PROSPECT");
  if (filters?.campaignId) query = query.eq("campaignId", filters.campaignId);
  if (filters?.partnerId) query = query.eq("referredByPartnerId", filters.partnerId);
  if (filters?.icpTier) query = query.eq("icpTier", filters.icpTier);
  if (filters?.region) query = query.eq("region", filters.region);
  if (filters?.leadList) query = query.eq("leadList", filters.leadList);
  if (filters?.search) {
    const s = filters.search.replace(/[,()]/g, "");
    query = query.or(
      `firstName.ilike.%${s}%,lastName.ilike.%${s}%,companyName.ilike.%${s}%,leadNumber.ilike.%${s}%,phone.ilike.%${s}%`,
    );
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load leads: ${error.message}`);

  return (data ?? []).map((l) => ({
    ...l,
    owner: one(l.owner as never),
    campaign: one(l.campaign as never),
    referredByPartner: one(l.referredByPartner as never),
  }));
}

// ---------------------------------------------------------------------------
// Campaigns & Products
// ---------------------------------------------------------------------------

export async function listCampaigns(filters?: { search?: string; status?: string }) {
  await requirePermission(PERMISSIONS.LEAD_READ);

  const db = await supabaseServer();

  let query = db
    .from("campaign")
    .select(
      `*,
       campaignType:campaign_type ( * ),
       owner:app_user!campaign_ownerUserId_fkey ( fullName ),
       members:campaign_member!campaign_member_campaignId_fkey ( count ),
       leads:lead!lead_campaignId_fkey ( count ),
       opportunities:opportunity ( count )`,
    )
    .is("deletedAt", null)
    .order("startDate", { ascending: false });

  if (filters?.status) query = query.eq("status", filters.status);
  query = applySearch(query, filters?.search, ["name", "campaignNumber"]);

  const { data, error } = await query.limit(LIST_LIMIT);

  if (error) throw new Error(`Could not load campaigns: ${error.message}`);

  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;

  return (data ?? []).map((row) => ({
    ...row,
    campaignType: one(row.campaignType as never),
    owner: one(row.owner as never),
    _count: {
      members: countOf(row.members),
      leads: countOf(row.leads),
      opportunities: countOf(row.opportunities),
    },
  }));
}

/** Campaign ROI straight from the v_campaign_performance view (spec §11). */
export async function getCampaignPerformance() {
  await requirePermission(PERMISSIONS.LEAD_READ);

  const db = await supabaseServer();

  // v_campaign_performance is a view (supabase/schema-sql/02_views.sql, applied to cloud
  // as migration 20260815000006). PostgREST selects from views like tables.
  const { data, error } = await db
    .from("v_campaign_performance")
    .select("*")
    .order("won_value", { ascending: false, nullsFirst: false });

  if (error) throw new Error(`Could not load campaign performance: ${error.message}`);

  return (data ?? []) as Array<{
    campaign_id: string;
    campaign_name: string;
    status: string;
    actual_cost: number | string;
    leads: number;
    converted_leads: number;
    opportunities: number;
    pipeline_value: number | string;
    won_value: number | string;
    roi_percent: number | string | null;
    cost_per_lead: number | string | null;
  }>;
}

export async function listProducts(
  activeOnly = true,
  filters?: { search?: string; productType?: string; category?: string },
) {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);

  const db = await supabaseServer();

  let query = db
    .from("product")
    .select("*, defaultTaxRate:tax_rate ( * )")
    .is("deletedAt", null)
    .order("name");

  if (activeOnly) query = query.eq("active", true);
  if (filters?.productType) query = query.eq("productType", filters.productType);
  if (filters?.category) query = query.eq("category", filters.category);
  query = applySearch(query, filters?.search, ["name", "productCode", "category"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load products: ${error.message}`);

  return (data ?? []).map((p) => ({ ...p, defaultTaxRate: one(p.defaultTaxRate as never) }));
}

/** Option lists for form dropdowns. */
export async function getFormOptions() {
  // Shared by the lead, account, contact and deal forms, so any one of those
  // read rights will do: requiring account:read here broke the lead form for
  // someone who works leads but not customers. Row security still decides
  // which accounts, contacts and partners each person is offered.
  const me = await requireUser();
  if (!canAny(me, PERMISSIONS.LEAD_READ, PERMISSIONS.ACCOUNT_READ, PERMISSIONS.OPPORTUNITY_READ)) {
    throw new AuthorizationError("Missing permission: lead:read, account:read or opportunity:read");
  }

  const db = await supabaseServer();

  const [users, accounts, campaigns, currencies, partners, contacts, products, taxRates] =
    await Promise.all([
      db
        .from("app_user")
        .select("id, fullName")
        .eq("status", "ACTIVE")
        .is("deletedAt", null)
        .order("fullName"),
      db
        .from("account")
        .select("id, name, accountType")
        .is("deletedAt", null)
        .order("name"),
      db
        .from("campaign")
        .select("id, name")
        .is("deletedAt", null)
        .in("status", ["PLANNED", "ACTIVE"])
        .order("name"),
      db.from("currency").select("*").eq("active", true).order("code"),
      db
        .from("partner")
        .select("id, displayName, partnerNumber, kind")
        .is("deletedAt", null)
        .eq("status", "ACTIVE")
        .order("displayName"),
      db
        .from("contact")
        .select("id, firstName, lastName, accountId")
        .is("deletedAt", null)
        .order("lastName")
        .order("firstName"),
      db
        .from("product")
        .select("id, name, productCode, defaultTaxRateId")
        .is("deletedAt", null)
        .eq("active", true)
        .order("name"),
      db
        .from("tax_rate")
        .select("id, name, ratePercent")
        .eq("active", true)
        .order("name"),
    ]);

  return {
    users: users.data ?? [],
    accounts: accounts.data ?? [],
    campaigns: campaigns.data ?? [],
    currencies: currencies.data ?? [],
    partners: partners.data ?? [],
    contacts: contacts.data ?? [],
    products: products.data ?? [],
    taxRates: taxRates.data ?? [],
  };
}

// ---------------------------------------------------------------------------
// Creating campaigns, products and activities
// ---------------------------------------------------------------------------
//
// These three had list screens but no way to add a row, so the only route in
// was the seed script. Permissions follow what the list pages already check:
// campaigns sit with leads (marketing), products with opportunities (they
// price the deal), and activities are open to any signed-in user, since
// everyone logs their own calls and tasks.

const campaignTypeSchema = z.object({
  name: z.string().trim().min(1, "Give the type a name.").max(100),
  // Free text rather than an enum: the channels a business runs campaigns on
  // are its own, and a fixed list would need a migration every time marketing
  // tried something new.
  channel: z.string().trim().max(100).optional().nullable(),
});

const campaignSchema = z.object({
  name: z.string().min(1, "Give the campaign a name.").max(200),
  campaignTypeId: z.string().uuid("Choose a campaign type."),
  ownerUserId: z.string().uuid("Choose an owner."),
  status: z.enum(["PLANNED", "ACTIVE", "PAUSED", "COMPLETED"]).default("PLANNED"),
  description: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  budgetAmount: z.coerce.number().min(0).optional().nullable(),
  expectedLeads: z.coerce.number().int().min(0).optional().nullable(),
  expectedRevenue: z.coerce.number().min(0).optional().nullable(),
});

/**
 * Creates a campaign type from inside the campaign form.
 *
 * Types were only ever seeded, never created: the "no campaign types yet"
 * notice pointed at a Settings screen that does not manage them, so a new
 * database left the Type field permanently unfillable and the campaign form
 * unusable. Rather than send someone away to a page that would not have helped,
 * the type is added where it is needed and selected on return.
 *
 * Gated on lead:write — the same permission the campaign form itself requires.
 * Someone entitled to create the campaign is entitled to name the kind of
 * campaign it is; a separate admin round-trip buys nothing here.
 */
export async function createCampaignType(
  input: z.infer<typeof campaignTypeSchema>,
): Promise<ActionResult<{ id: string; name: string }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = campaignTypeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();

  // Case-insensitive, because "Webinar" and "webinar" in the same dropdown is a
  // reporting problem later, not a naming preference now.
  const { data: clash } = await db
    .from("campaign_type")
    .select("id, name")
    .ilike("name", d.name)
    .maybeSingle();

  if (clash) {
    return {
      ok: false,
      error: `"${clash.name}" already exists.`,
      fieldErrors: { name: ["This type is already on the list."] },
    };
  }

  try {
    const created = await createRecord<{ id: string; name: string }>(
      "campaign_type",
      { name: d.name, channel: d.channel || null, active: true },
    );
    revalidatePath("/campaigns");
    return { ok: true, data: { id: created.id, name: created.name } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not add the campaign type.",
    };
  }
}

export async function createCampaign(
  input: z.infer<typeof campaignSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.startDate && d.endDate && d.endDate < d.startDate) {
    return {
      ok: false,
      error: "The campaign cannot end before it starts.",
      fieldErrors: { endDate: ["Must be on or after the start date."] },
    };
  }

  try {
    const created = await createRecord<{ id: string }>(
      "campaign",
      {
        name: d.name,
        campaignTypeId: d.campaignTypeId,
        ownerUserId: d.ownerUserId,
        status: d.status,
        description: d.description || null,
        startDate: d.startDate || null,
        endDate: d.endDate || null,
        budgetAmount: d.budgetAmount ?? null,
        actualCost: 0,
        expectedLeads: d.expectedLeads ?? null,
        expectedRevenue: d.expectedRevenue ?? null,
      },
      { field: "campaignNumber", sequence: SEQUENCES.CAMPAIGN },
    );

    revalidatePath("/campaigns");
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const productSchema = z.object({
  productCode: z.string().min(1, "Give the product a code.").max(50),
  name: z.string().min(1, "Give the product a name.").max(200),
  productType: z.enum(["PRODUCT", "SERVICE", "SUBSCRIPTION"]),
  description: z.string().optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  defaultTaxRateId: z.string().uuid().optional().nullable(),
  commissionPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  // Not on the form. Whether a product may still be sold, and whether it earns
  // commission, are lifecycle facts rather than catalogue detail: active is
  // toggled from the product page, commissionable from the commission rules.
  commissionable: z.coerce.boolean().default(true),
  active: z.coerce.boolean().default(true),
});

const createProductSchema = productSchema.omit({ productCode: true });

export async function createProduct(
  input: z.infer<typeof createProductSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  try {
    const options = await getProductOptions();
    if (d.category) {
      const canonical = options.categories.find((value) => optionKey(value) === optionKey(d.category!));
      if (!canonical) return { ok: false, error: "Choose an existing category, or create it first.", fieldErrors: { category: ["Select or create an option first."] } };
      d.category = canonical;
    }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Could not load product options." }; }


  // Generate on the server. The existing
  // product_productCode_key unique index is the final concurrency-safe guard.
  const productCode = `PRD-${randomUUID().toUpperCase()}`;


  try {
    const db = await supabaseServer();

    const { data: clash } = await db
      .from("product")
      .select("id")
      .eq("productCode", productCode)
      .maybeSingle();

    if (clash) {
      return {
        ok: false,
        error: `Product code ${productCode} is already in use.`,
        fieldErrors: { productCode: ["Already in use."] },
      };
    }

    const created = await createRecord<{ id: string }>("product", {
      productCode,
      name: d.name,
      productType: d.productType,
      description: d.description || null,
      category: d.category || null,
      defaultTaxRateId: d.defaultTaxRateId || null,
      commissionPercent: d.commissionPercent ?? null,
      commissionable: d.commissionable,
      active: d.active,
    });

    revalidatePath("/products");
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const activityBase = z.object({
  activityType: picklistCode,
  subject: z.string().min(1, "Give the activity a subject.").max(255),
  ownerUserId: z.string().uuid("Choose an owner."),
  description: z.string().optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  startAt: z.string().optional().nullable(),
  dueAt: z.string().optional().nullable(),
  location: z.string().max(255).optional().nullable(),
  /** Which medium a message went out on. Only meaningful for MESSAGE_SENT. */
  channel: z.enum(MESSAGE_CHANNELS).optional().nullable(),
  /** Attribution: the campaign this touch was made as part of. */
  campaignId: z.string().uuid().optional().nullable().or(z.literal("")),
  /** What the touch concerns — the lead, case or deal it was about. */
  relatedEntityType: z.string().max(50).optional().nullable(),
  relatedEntityId: z.string().uuid().optional().nullable().or(z.literal("")),
});

/**
 * Without the channel a message is unattributable to a medium, which is the
 * entire reason MESSAGE_SENT exists as a separate type. Applied to both the
 * create and update schemas rather than baked into the base, because
 * `.refine()` yields a ZodEffects that can no longer be `.extend()`ed.
 */
const requireChannelForMessage = (d: {
  activityType: string;
  channel?: string | null;
}): boolean => d.activityType !== "MESSAGE_SENT" || Boolean(d.channel);

const CHANNEL_ISSUE = {
  message: "Choose which channel the message went out on.",
  path: ["channel"],
};

const activitySchema = activityBase.refine(requireChannelForMessage, CHANNEL_ISSUE);

export async function createActivity(
  input: z.infer<typeof activitySchema>,
): Promise<ActionResult<{ id: string }>> {
  // No dedicated permission: logging your own call or task is not a privileged
  // act, and requireUser() has already established who is asking.
  const me = await requireUser();

  const parsed = activitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.startAt && d.dueAt && d.dueAt < d.startAt) {
    return {
      ok: false,
      error: "It cannot be due before it starts.",
      fieldErrors: { dueAt: ["Must be on or after the start."] },
    };
  }

  try {
    const created = await createRecord<{ id: string }>("activity", {
      activityType: d.activityType,
      subject: d.subject,
      ownerUserId: d.ownerUserId || me.id,
      description: d.description || null,
      contactId: d.contactId || null,
      priority: d.priority,
      startAt: d.startAt || null,
      dueAt: d.dueAt || null,
      location: d.location || null,
      // A channel on a call or meeting would be noise in the reports, so it is
      // only kept for the type it describes.
      channel: d.activityType === "MESSAGE_SENT" ? d.channel : null,
      campaignId: d.campaignId || null,
      relatedEntityType: d.relatedEntityType || null,
      relatedEntityId: d.relatedEntityId || null,
      // "Message sent" is past tense by definition — there is nothing left to
      // do, so filing one as OPEN would leave every logged touch sitting in
      // the rep's task list forever. A call or meeting can still be scheduled
      // ahead of time, so those stay OPEN.
      ...(d.activityType === "MESSAGE_SENT"
        ? { status: "COMPLETED", completedAt: new Date().toISOString() }
        : { status: "OPEN" }),
    });

    revalidatePath("/activities");
    if (d.campaignId) revalidatePath(`/campaigns/${d.campaignId}`);
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function getCampaign(id: string) {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("campaign")
    .select(
      `*,
       campaignType:campaign_type ( id, name, channel ),
       owner:app_user!campaign_ownerUserId_fkey ( id, fullName )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load campaign: ${error.message}`);
  if (!data) return null;

  return {
    ...data,
    campaignType: one(data.campaignType as never),
    owner: one(data.owner as never),
  };
}

export async function updateCampaign(
  id: string,
  input: z.infer<typeof campaignSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.startDate && d.endDate && d.endDate < d.startDate) {
    return {
      ok: false,
      error: "The campaign cannot end before it starts.",
      fieldErrors: { endDate: ["Must be on or after the start date."] },
    };
  }

  const gate = await editGate("Campaign", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    await updateRecord(
      "campaign",
      id,
      {
        name: d.name,
        campaignTypeId: d.campaignTypeId,
        ownerUserId: d.ownerUserId,
        status: d.status,
        description: d.description || null,
        startDate: d.startDate || null,
        endDate: d.endDate || null,
        budgetAmount: d.budgetAmount ?? null,
        expectedLeads: d.expectedLeads ?? null,
        expectedRevenue: d.expectedRevenue ?? null,
      },
      "Campaign",
      _auth.user.id,
    );
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the campaign." };
  }
}

/** Retire a product, or put it back on sale, without touching its details. */
export async function setProductActive(id: string, active: boolean): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    await updateRecord("product", id, { active }, "Product", _auth.user.id);
    revalidatePath("/products");
    revalidatePath(`/products/${id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not change the product." };
  }
}

export async function getProduct(id: string) {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("product")
    .select("*, defaultTaxRate:tax_rate ( id, name, ratePercent )")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load product: ${error.message}`);
  if (!data) return null;

  return { ...data, defaultTaxRate: one(data.defaultTaxRate as never) };
}

export async function updateProduct(
  id: string,
  input: z.infer<typeof createProductSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  try {
    const options = await getProductOptions();
    if (d.category) {
      const canonical = options.categories.find((value) => optionKey(value) === optionKey(d.category!));
      if (!canonical) return { ok: false, error: "Choose an existing category, or create it first.", fieldErrors: { category: ["Select or create an option first."] } };
      d.category = canonical;
    }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Could not load product options." }; }



  try {
    await updateRecord(
      "product",
      id,
      {
        name: d.name,
        productType: d.productType,
        description: d.description || null,
        category: d.category || null,
        defaultTaxRateId: d.defaultTaxRateId || null,
        commissionPercent: d.commissionPercent ?? null,
        // commissionable and active are deliberately absent: they are not on
        // the form, and writing their schema defaults here would put a retired
        // product back on sale every time someone fixed a typo.
      },
      "Product",
      _auth.user.id,
    );

    revalidatePath("/products");
    revalidatePath(`/products/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the product." };
  }
}

export async function getActivity(id: string) {
  const me = await requireUser();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("activity")
    .select(
      `*,
       owner:app_user!activity_ownerUserId_fkey ( id, fullName ),
       contact ( id, firstName, lastName, email, phone, account ( id, name ) )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load activity: ${error.message}`);
  if (!data) return null;

  const contact = one(data.contact as never) as Record<string, unknown> | null;

  return {
    ...data,
    owner: one(data.owner as never),
    contact: contact ? { ...contact, account: one(contact.account as never) } : null,
    // The activities screen is "mine", so the detail page says plainly whether
    // this one belongs to the reader before they try to complete it.
    isMine: data.ownerUserId === me.id,
  };
}

const activityUpdateSchema = activityBase
  .extend({
    status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]).default("OPEN"),
    outcome: z.string().optional().nullable(),
  })
  .refine(requireChannelForMessage, CHANNEL_ISSUE);

export async function updateActivity(
  id: string,
  input: z.infer<typeof activityUpdateSchema>,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();

  const parsed = activityUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.startAt && d.dueAt && d.dueAt < d.startAt) {
    return {
      ok: false,
      error: "It cannot be due before it starts.",
      fieldErrors: { dueAt: ["Must be on or after the start."] },
    };
  }

  try {
    await updateRecord(
      "activity",
      id,
      {
        activityType: d.activityType,
        subject: d.subject,
        ownerUserId: d.ownerUserId,
        description: d.description || null,
        contactId: d.contactId || null,
        priority: d.priority,
        startAt: d.startAt || null,
        dueAt: d.dueAt || null,
        location: d.location || null,
        channel: d.activityType === "MESSAGE_SENT" ? d.channel : null,
        campaignId: d.campaignId || null,
        relatedEntityType: d.relatedEntityType || null,
        relatedEntityId: d.relatedEntityId || null,
        status: d.status,
        outcome: d.outcome || null,
        // Completing an activity stamps the time, so the list can show when it
        // actually happened rather than only that it is done.
        completedAt: d.status === "COMPLETED" ? new Date().toISOString() : null,
      },
      "Activity",
      me.id,
    );

    revalidatePath("/activities");
    revalidatePath(`/activities/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the activity." };
  }
}

/** Options the three new forms need: types, owners, tax rates and contacts. */
export async function getCreateFormOptions() {
  await requireUser();
  const db = await supabaseServer();

  const [campaignTypes, users, taxRates, contacts, campaigns] = await Promise.all([
    db.from("campaign_type").select("id, name").eq("active", true).order("name"),
    db.from("app_user").select("id, fullName").eq("status", "ACTIVE").is("deletedAt", null).order("fullName"),
    db.from("tax_rate").select("id, name, ratePercent").eq("active", true).order("name"),
    db
      .from("contact")
      .select("id, firstName, lastName")
      .eq("active", true)
      .is("deletedAt", null)
      .order("firstName")
      .limit(500),
    // COMPLETED campaigns are excluded: attributing a touch made today to a
    // campaign that has already been reported on would silently change a
    // number someone has acted on. A finished campaign is history.
    db
      .from("campaign")
      .select("id, name, status")
      .in("status", ["PLANNED", "ACTIVE", "PAUSED"])
      .is("deletedAt", null)
      .order("name")
      .limit(500),
  ]);

  return {
    campaignTypes: campaignTypes.data ?? [],
    users: users.data ?? [],
    taxRates: taxRates.data ?? [],
    contacts: contacts.data ?? [],
    campaigns: campaigns.data ?? [],
  };
}

/**
 * What a product has cost to build, and what it has earned.
 *
 * This is the question the project↔product link exists to answer, and neither
 * half could answer it alone: cost lives on the projects that build the thing,
 * revenue lives on the invoice lines that sell it.
 *
 * The two sides are deliberately asymmetric, because the business is:
 *
 *   * **Cost** is every hour logged to any project carrying this product,
 *     valued at the rate stamped on each entry. That includes the internal R&D
 *     project that built it and any customer delivery project for it.
 *   * **Revenue** is every invoice line carrying this product. A product sold
 *     to five customers has five sets of lines and one build cost, which is the
 *     whole point of building a product rather than doing bespoke work.
 *
 * A product still in development shows cost and no revenue. That is not a
 * failure of the report — it is the honest state of an investment that has not
 * paid back yet, and seeing it is the reason to look.
 */
export async function getProductEconomics(productId: string) {
  const viewer = await requireUser();
  if (!can(viewer, PERMISSIONS.PROJECT_RATES_READ)) return null;
  // Products are gated on OPPORTUNITY_READ everywhere in this app — the
  // catalogue page included — so this follows rather than inventing a rule.
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);

  const db = await supabaseServer();

  const { data: product, error: productError } = await db
    .from("product")
    .select("id, productCode, name, productType, active")
    .eq("id", productId)
    .maybeSingle();

  // A malformed id names a record that cannot exist, which is a 404 rather than
  // a server fault.
  if (productError) {
    if (productError.code === "22P02") return null;
    throw new Error(`Could not load the product: ${productError.message}`);
  }
  if (!product) return null;

  const [projectsRes, invoiceLinesRes] = await Promise.all([
    db
      .from("project")
      .select(
        `id, name, projectNumber, projectType, status, health, completionPercent,
         startDate, plannedEndDate, approvedHours,
         account ( id, name )`,
      )
      .eq("productId", productId)
      .is("deletedAt", null)
      .order("projectNumber"),

    db
      .from("invoice_line")
      .select(
        `id, quantity, unitPrice, lineTotal,
         invoice!inner ( id, invoiceNumber, status, invoiceDate, deletedAt,
                         account ( id, name ) )`,
      )
      .eq("productId", productId)
      .is("invoice.deletedAt", null)
      .limit(2000),
  ]);

  // A broken query and an empty result are different things: letting a failed
  // select read as zero would report a product that cost nothing and earned
  // nothing, which is the most misleading answer available.
  for (const [what, res] of [
    ["projects", projectsRes],
    ["invoice lines", invoiceLinesRes],
  ] as const) {
    if (res.error) {
      throw new Error(`Could not load ${what} for this product: ${res.error.message}`);
    }
  }

  const projects: Record<string, any>[] = ((projectsRes.data ?? []) as Record<string, any>[]).map(
    (p) => ({ ...p, account: one(p.account as never) as { id: string; name: string } | null }),
  );

  const projectIds = projects.map((p) => String(p.id));

  // Hours on every project for this product, valued at the rates stamped on
  // each entry rather than anyone's current rate card.
  const logsRes = projectIds.length
    ? await db
        .from("time_log")
        .select("id, projectId, userId, hours, billable, approvalStatus")
        .in("projectId", projectIds)
        .neq("approvalStatus", "REJECTED")
        .limit(20000)
    : { data: [], error: null };

  if (logsRes.error) {
    throw new Error(`Could not load time for this product: ${logsRes.error.message}`);
  }
  const logs = await withRateSnapshots("time_log", (logsRes.data ?? []) as Array<Record<string, any> & {id: string}>);

  const hours = logs.reduce((a, l) => a.plus(toDecimal(l.hours)), toDecimal(0));
  const cost = logs.reduce(
    (a, l) => a.plus(toDecimal(l.hours).times(toDecimal(l.costRate))),
    toDecimal(0),
  );

  // Per project, so the reader can see which piece of work the money went into.
  const byProject = projects.map((p) => {
    const mine = logs.filter((l) => String(l.projectId) === String(p.id));
    return {
      id: String(p.id),
      name: String(p.name),
      projectNumber: String(p.projectNumber),
      projectType: String(p.projectType ?? "CUSTOMER"),
      status: String(p.status),
      health: String(p.health ?? "GREEN"),
      accountName: p.account?.name ?? null,
      completionPercent: Number(p.completionPercent ?? 0),
      hours: Number(
        mine.reduce((a, l) => a.plus(toDecimal(l.hours)), toDecimal(0)).toDecimalPlaces(1),
      ),
      cost: Number(
        mine
          .reduce((a, l) => a.plus(toDecimal(l.hours).times(toDecimal(l.costRate))), toDecimal(0))
          .toDecimalPlaces(2),
      ),
      people: new Set(mine.map((l) => String(l.userId))).size,
    };
  });

  // --- Revenue -------------------------------------------------------------
  const lines: Record<string, any>[] = ((invoiceLinesRes.data ?? []) as Record<string, any>[]).map((l) => {
    const invoice = one(l.invoice as never) as Record<string, any> | null;
    return {
      ...l,
      invoice,
      invoiceAccount: invoice ? (one(invoice.account as never) as { id: string; name: string } | null) : null,
    };
  });

  // Cancelled invoices are excluded: they are a record that something was
  // withdrawn, not money earned.
  const counted = lines.filter((l) => String(l.invoice?.status) !== "CANCELLED");

  const revenue = counted.reduce((a, l) => a.plus(toDecimal(l.lineTotal ?? 0)), toDecimal(0));
  const unitsSold = counted.reduce((a, l) => a.plus(toDecimal(l.quantity ?? 0)), toDecimal(0));

  // Only settled invoices are money actually received; the rest is owed.
  const collected = counted
    .filter((l) => String(l.invoice?.status) === "PAID")
    .reduce((a, l) => a.plus(toDecimal(l.lineTotal ?? 0)), toDecimal(0));

  const customers = new Map<string, { id: string; name: string; revenue: ReturnType<typeof toDecimal>; invoices: number }>();
  for (const l of counted) {
    const acct = l.invoiceAccount;
    if (!acct) continue;
    const entry =
      customers.get(String(acct.id)) ??
      { id: String(acct.id), name: String(acct.name), revenue: toDecimal(0), invoices: 0 };
    entry.revenue = entry.revenue.plus(toDecimal(l.lineTotal ?? 0));
    entry.invoices += 1;
    customers.set(String(acct.id), entry);
  }

  const margin = revenue.minus(cost);

  return {
    product,

    investment: {
      hours: Number(hours.toDecimalPlaces(1)),
      cost: Number(cost.toDecimalPlaces(2)),
      projects: projects.length,
      /** People who have ever logged time to this product. */
      people: new Set(logs.map((l) => String(l.userId))).size,
    },

    earnings: {
      revenue: Number(revenue.toDecimalPlaces(2)),
      collected: Number(collected.toDecimalPlaces(2)),
      outstanding: Number(revenue.minus(collected).toDecimalPlaces(2)),
      unitsSold: Number(unitsSold.toDecimalPlaces(2)),
      customers: customers.size,
      invoiceLines: counted.length,
    },

    /**
     * Revenue less build cost. Negative while a product is still an investment,
     * which is the normal state before it has sold — and worth seeing plainly
     * rather than hiding behind a zero.
     */
    margin: Number(margin.toDecimalPlaces(2)),
    marginPercent: revenue.greaterThan(0)
      ? Number(margin.dividedBy(revenue).times(100).toDecimalPlaces(1))
      : null,
    /** True once it has earned back what it cost to build. */
    hasPaidBack: revenue.greaterThanOrEqualTo(cost) && revenue.greaterThan(0),

    byProject,

    byCustomer: [...customers.values()]
      .map((c) => ({ ...c, revenue: Number(c.revenue.toDecimalPlaces(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}
