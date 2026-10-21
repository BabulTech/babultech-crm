"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import Decimal from "decimal.js";
import { toDecimal, one } from "@/lib/decimal";
import { supabaseServer } from "@/lib/supabase";
import { updateRecord, LIST_LIMIT } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import type { DuplicateRef } from "@/lib/duplicates";

/**
 * Partner management.
 *
 * A partner is either a COMPANY (backed by an Account with accountType =
 * PARTNER) or an INDIVIDUAL (backed by a Contact with no account at all).
 * `createPartner` handles both, creating the underlying Account/Contact when
 * one isn't supplied — so a freelance referrer can be onboarded in one step
 * without inventing a fake company.
 */

const addressSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
  .optional();

const basePartnerSchema = z.object({
  partnerType: z.enum(["REFERRAL", "ACCOUNT_MANAGEMENT", "IMPLEMENTATION", "INVESTMENT"]),
  tier: z.enum(["SILVER", "GOLD", "PLATINUM"]).default("SILVER"),
  // Inactive by default. An active partnership can register deals, add
  // customers and use the portal, and none of that should start by accident.
  status: z.enum(["ACTIVE", "INACTIVE", "TERMINATED"]).default("INACTIVE"),
  partnerManagerId: z.string().uuid().optional().nullable(),
  territory: z.string().max(150).optional().nullable(),
  startDate: z.coerce.date().optional().nullable(),
  agreementExpiryDate: z.coerce.date().optional().nullable(),
  defaultCommissionPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  payoutCurrencyCode: z.string().length(3).default("PKR"),
  taxNumber: z.string().max(50).optional().nullable(),
  withholdingTaxPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  website: z.string().max(255).optional().nullable(),
  notes: z.string().optional().nullable(),
  bankDetails: z
    .object({
      bankName: z.string().optional(),
      accountTitle: z.string().optional(),
      accountNumber: z.string().optional(),
      iban: z.string().optional(),
      branch: z.string().optional(),
    })
    .optional()
    .nullable(),
});

const companyPartnerSchema = basePartnerSchema.extend({
  kind: z.literal("COMPANY"),
  /** Link an existing account, or supply companyName to create one. */
  accountId: z.string().uuid().optional().nullable(),
  companyName: z.string().min(1).max(200).optional(),
  industry: z.string().max(100).optional().nullable(),
  billingAddress: addressSchema,
  /** Optional named person at the partner company. */
  primaryContactFirstName: z.string().max(100).optional(),
  primaryContactLastName: z.string().max(100).optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")),
});

const individualPartnerSchema = basePartnerSchema.extend({
  kind: z.literal("INDIVIDUAL"),
  /** Link an existing contact, or supply the name to create one. */
  contactId: z.string().uuid().optional().nullable(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  mobile: z.string().max(50).optional().nullable(),
  whatsapp: z.string().max(50).optional().nullable(),
});

// Not exported: a "use server" module may only export async functions.
// Types are erased at build time, so the inferred type below is fine to export.
const partnerSchema = z.discriminatedUnion("kind", [
  companyPartnerSchema,
  individualPartnerSchema,
]);

export type PartnerInput = z.infer<typeof partnerSchema>;

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      /** The record that already exists, when a save was refused as a duplicate person. */
      duplicate?: DuplicateRef;
    };

export async function createPartner(input: PartnerInput): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PARTNER_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = partnerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    // Account/contact creation, the PARTNER-type promotion and the partner row
    // all in one transaction — partner_identity_check requires the account or
    // contact to exist first, and a half-done create would leave an account
    // silently promoted to PARTNER with no partner behind it.
    // Split by branch: `data` is a discriminated union, so the COMPANY-only and
    // INDIVIDUAL-only fields are not both present on it.
    const kindFields =
      data.kind === "COMPANY"
        ? {
            accountId: data.accountId ?? null,
            companyName: data.companyName ?? null,
            industry: data.industry ?? null,
            billingAddress: data.billingAddress ?? null,
            primaryContactFirstName: data.primaryContactFirstName ?? null,
            primaryContactLastName: data.primaryContactLastName ?? null,
            primaryContactEmail: data.primaryContactEmail ?? null,
          }
        : {
            contactId: data.contactId ?? null,
            firstName: data.firstName ?? null,
            lastName: data.lastName ?? null,
            mobile: data.mobile ?? null,
            whatsapp: data.whatsapp ?? null,
          };

    const { data: partner, error } = await db.rpc("create_partner", {
      p_payload: {
        kind: data.kind,
        ...kindFields,
        partnerType: data.partnerType,
        tier: data.tier,
        status: data.status,
        partnerManagerId: data.partnerManagerId ?? null,
        territory: data.territory ?? null,
        startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
        agreementExpiryDate: data.agreementExpiryDate
          ? data.agreementExpiryDate.toISOString().slice(0, 10)
          : null,
        defaultCommissionPercent: data.defaultCommissionPercent ?? null,
        payoutCurrencyCode: data.payoutCurrencyCode,
        taxNumber: data.taxNumber ?? null,
        withholdingTaxPercent: data.withholdingTaxPercent ?? null,
        bankDetails: data.bankDetails ?? null,
        website: data.website ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        notes: data.notes ?? null,
      },
      p_actor_id: user.id,
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath("/partners");
    return { ok: true, data: { id: partner.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the partner." };
  }
}

const updatePartnerSchema = basePartnerSchema.partial().extend({ id: z.string().uuid() });

export async function updatePartner(
  input: z.infer<typeof updatePartnerSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PARTNER_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = updatePartnerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, ...changes } = parsed.data;

  try {
    await updateRecord(
      "partner",
      id,
      {
        ...changes,
        email: changes.email === "" ? null : changes.email,
        bankDetails: changes.bankDetails ?? null,
        startDate: changes.startDate
          ? changes.startDate.toISOString().slice(0, 10)
          : changes.startDate,
        agreementExpiryDate: changes.agreementExpiryDate
          ? changes.agreementExpiryDate.toISOString().slice(0, 10)
          : changes.agreementExpiryDate,
      },
      "Partner",
      user.id,
    );

    revalidatePath("/partners");
    revalidatePath(`/partners/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the partner." };
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Every partner the viewer may read, by name - the choices for a "Partner"
 * filter. Row-level security decides who that is; somebody who may not read
 * partners gets none, and the filter is not shown.
 */
export async function listPartnerOptions(): Promise<{ id: string; displayName: string }[]> {
  const db = await supabaseServer();
  const { data } = await db
    .from("partner")
    .select("id, displayName")
    .is("deletedAt", null)
    .order("displayName");
  return (data ?? []) as { id: string; displayName: string }[];
}

export async function listPartners(filters?: {
  search?: string;
  status?: string;
  partnerType?: string;
  kind?: string;
}) {
  await requirePermission(PERMISSIONS.PARTNER_READ);

  const db = await supabaseServer();

  let query = db
    .from("partner")
    .select(
      `*,
       account!partner_accountId_fkey ( id, name ),
       contact!partner_contactId_fkey ( id, firstName, lastName, email ),
       partnerManager:app_user!partner_partnerManagerId_fkey ( id, fullName ),
       opportunities:opportunity!opportunity_sourcePartnerId_fkey ( count ),
       commissions:partner_commission ( count ),
       referredLeads:lead ( count )`,
    )
    .is("deletedAt", null)
    .order("createdAt", { ascending: false });

  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.partnerType) query = query.eq("partnerType", filters.partnerType);
  if (filters?.kind) query = query.eq("kind", filters.kind);
  if (filters?.search) {
    const s = filters.search.replace(/[,()]/g, "");
    query = query.or(
      `displayName.ilike.%${s}%,partnerNumber.ilike.%${s}%,email.ilike.%${s}%`,
    );
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load partners: ${error.message}`);

  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;

  return (data ?? []).map((p) => ({
    ...p,
    account: one(p.account as never),
    contact: one(p.contact as never),
    partnerManager: one(p.partnerManager as never),
    _count: {
      opportunities: countOf(p.opportunities),
      commissions: countOf(p.commissions),
      referredLeads: countOf(p.referredLeads),
    },
  }));
}

export async function getPartner(id: string) {
  await requirePermission(PERMISSIONS.PARTNER_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("partner")
    .select(
      `*,
       account!partner_accountId_fkey ( * ),
       contact!partner_contactId_fkey ( * ),
       partnerManager:app_user!partner_partnerManagerId_fkey ( id, fullName, email ),
       contacts:partner_contact ( *, contact ( * ) ),
       referredLeads:lead ( id, leadNumber, firstName, lastName, companyName, status, estimatedValue, createdAt, deletedAt ),
       opportunities:opportunity!opportunity_sourcePartnerId_fkey (
         id, opportunityNumber, name, stage, amount, currencyCode,
         expectedCloseDate, createdAt, deletedAt, account ( name )
       ),
       commissions:partner_commission (
         id, commissionNumber, status, commissionPercent, commissionAmount,
         withholdingAmount, partnerAmount, currencyCode, paymentDate, createdAt,
         requestStatus, opportunity ( id, opportunityNumber, name, stage )
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load partner: ${error.message}`);
  if (!data) return null;

  // PostgREST returns embedded collections unfiltered and unordered, so the
  // per-relation where/orderBy/take from the Prisma query are applied here.
  type Row = Record<string, unknown>;
  const rows = (v: unknown) => ((v as Row[] | null) ?? []);
  const desc = (a: unknown, b: unknown) => String(b ?? "").localeCompare(String(a ?? ""));

  return {
    ...data,
    account: one(data.account as never),
    contact: one(data.contact as never),
    partnerManager: one(data.partnerManager as never),
    contacts: rows(data.contacts).map((c): Row => ({ ...c, contact: one(c.contact as never) })),
    referredLeads: rows(data.referredLeads)
      .filter((l) => !l.deletedAt)
      .sort((a, b) => desc(a.createdAt, b.createdAt))
      .slice(0, 20),
    opportunities: rows(data.opportunities)
      .filter((o) => !o.deletedAt)
      .map((o): Row => ({ ...o, account: one(o.account as never) }))
      .sort((a, b) => desc(a.createdAt, b.createdAt)),
    commissions: rows(data.commissions)
      .map((c): Row => ({ ...c, opportunity: one(c.opportunity as never) }))
      .sort((a, b) => desc(a.createdAt, b.createdAt)),
  };
}

/** Headline numbers for the partner detail page. Amounts paid to the partner are after withholding. */
export async function getPartnerSummary(partnerId: string) {
  await requirePermission(PERMISSIONS.PARTNER_READ);

  const db = await supabaseServer();

  const [dealsRes, commissionsRes] = await Promise.all([
    db
      .from("opportunity")
      .select("stage, amount")
      .eq("sourcePartnerId", partnerId)
      .is("deletedAt", null),
    db
      .from("partner_commission")
      .select("status, partnerAmount, opportunity ( stage )")
      .eq("partnerId", partnerId),
  ]);

  const deals = (dealsRes.data ?? []) as { stage: string; amount: unknown }[];
  const won = deals.filter((d) => d.stage === "CLOSED_WON");
  const lost = deals.filter((d) => d.stage === "CLOSED_LOST");
  const open = deals.filter((d) => d.stage !== "CLOSED_WON" && d.stage !== "CLOSED_LOST");
  const valueOf = (rows: { amount: unknown }[]) =>
    rows.reduce((sum, d) => sum.plus(toDecimal(d.amount)), toDecimal(0));

  const commissions = (commissionsRes.data ?? []).map((c) => ({
    status: c.status as string,
    amount: toDecimal(c.partnerAmount),
    stage: (one(c.opportunity as never) as { stage?: string } | null)?.stage ?? null,
  }));
  const total = (pick: (c: (typeof commissions)[number]) => boolean): Decimal =>
    commissions.filter(pick).reduce((sum, c) => sum.plus(c.amount), toDecimal(0));

  return {
    dealsOpen: open.length,
    dealsWon: won.length,
    dealsLost: lost.length,
    openPipeline: valueOf(open),
    wonValue: valueOf(won),
    winRate: won.length + lost.length === 0 ? null : (won.length / (won.length + lost.length)) * 100,
    /** On deals still open: an estimate that moves with the deal. */
    commissionAccrued: total((c) => c.status === "IN_PROGRESS" && c.stage !== "CLOSED_WON"),
    /** On won deals, not yet paid. */
    commissionPayable: total((c) => c.status === "IN_PROGRESS" && c.stage === "CLOSED_WON"),
    commissionPaid: total((c) => c.status === "PAID"),
  };
}
