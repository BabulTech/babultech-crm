"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/supabase";
import { updateRecord } from "@/lib/db";
import { Resend } from "@/lib/mail";
import { isReservedAddress } from "@/lib/notification-mailer";
import type { ActionResult } from "./partners";

/**
 * Partner profile changes: requested in the portal, decided by an
 * administrator, applied only on approval. The partner id always comes from the
 * session, and only these fields can ever be requested; type, tier, status,
 * manager, agreement dates and notes stay out of reach.
 */

const bankSchema = z.object({
  bankName: z.string().max(150).default(""),
  accountTitle: z.string().max(150).default(""),
  accountNumber: z.string().max(60).default(""),
  iban: z.string().max(60).default(""),
  branch: z.string().max(150).default(""),
});

const requestSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a name.").max(200),
  email: z.string().trim().email("That does not look like an email address.").or(z.literal("")),
  phone: z.string().trim().max(50),
  website: z.string().trim().max(255),
  territory: z.string().trim().max(150),
  taxNumber: z.string().trim().max(50),
  defaultCommissionPercent: z.coerce.number().min(0).max(100),
  withholdingTaxPercent: z.coerce.number().min(0).max(100),
  payoutCurrencyCode: z.string().trim().toUpperCase().length(3, "Use a 3-letter currency code."),
  bankDetails: bankSchema,
  reason: z.string().trim().max(1000).optional(),
});

const FIELDS = ["displayName", "email", "phone", "website", "territory", "taxNumber", "defaultCommissionPercent",
  "withholdingTaxPercent", "payoutCurrencyCode", "bankDetails"] as const;
type Field = (typeof FIELDS)[number];

export interface PartnerChangeRequest {
  id: string;
  partnerId: string;
  requestedById: string | null;
  requestedByName: string;
  changes: Partial<Record<Field, { from: unknown; to: unknown }>>;
  reason: string | null;
  status: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

const normal = (field: Field, v: unknown): unknown => {
  if (field === "bankDetails") {
    const b = (v ?? {}) as Record<string, unknown>;
    return { bankName: b.bankName ?? "", accountTitle: b.accountTitle ?? "", accountNumber: b.accountNumber ?? "", iban: b.iban ?? "", branch: b.branch ?? "" };
  }
  if (field === "defaultCommissionPercent" || field === "withholdingTaxPercent") return Number(v ?? 0);
  return v ?? "";
};

async function portalAdmin() {
  const me = await requireUser();
  if (!me.partnerId) throw new Error("This account is not a partner portal login.");
  return me;
}

async function loadEditable(partnerId: string) {
  const { data } = await supabaseAdmin().from("partner").select(FIELDS.join(", ")).eq("id", partnerId).single();
  return data as unknown as Record<Field, unknown>;
}

/** The portal form. Bank details are for the partner's portal admin only. */
export async function getMyPartnerChanges() {
  const me = await portalAdmin();
  const isAdmin = me.portalRole === "ADMIN";
  const current = await loadEditable(me.partnerId!);
  const { data } = await supabaseAdmin().from("partner_change_request").select("*")
    .eq("partnerId", me.partnerId!).order("createdAt", { ascending: false }).limit(5);
  const history = (data ?? []) as PartnerChangeRequest[];
  const hideBank = (r: PartnerChangeRequest) => {
    if (isAdmin || !r.changes.bankDetails) return r;
    const { bankDetails: _hidden, ...changes } = r.changes;
    return { ...r, changes };
  };
  return {
    isAdmin,
    current: isAdmin ? current : { ...current, bankDetails: null },
    pending: history.filter((r) => r.status === "PENDING").map(hideBank)[0] ?? null,
    latest: history.filter((r) => r.status !== "PENDING").map(hideBank)[0] ?? null,
  };
}

export async function requestPartnerChange(input: unknown): Promise<ActionResult> {
  const me = await portalAdmin();
  if (me.portalRole !== "ADMIN") return { ok: false, error: "Only your portal admin can request changes." };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };

  const current = await loadEditable(me.partnerId!);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of FIELDS) {
    const from = normal(field, current[field]);
    const to = normal(field, parsed.data[field]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: "Nothing has changed." };

  const admin = supabaseAdmin();
  const { data: row, error } = await admin.from("partner_change_request").insert({
    partnerId: me.partnerId, requestedById: me.id, requestedByName: me.fullName, changes, reason: parsed.data.reason || null,
  }).select("id").single();
  if (error) {
    return { ok: false, error: error.code === "23505" ? "You already have a change waiting for approval. Withdraw it to send a new one." : "Could not send the request. Try again." };
  }

  const { data: holders } = await admin.rpc("app_users_holding", { p_permission: "admin:*" });
  await Promise.all(((holders ?? []) as unknown[]).map((h) => admin.rpc("notify_user", {
    p_user: typeof h === "string" ? h : Object.values(h as object)[0],
    p_kind: "APPROVAL_REQUESTED",
    p_title: `Partner profile change needs approval${changes.bankDetails ? " (bank details)" : ""}`,
    p_body: `${current.displayName}: ${Object.keys(changes).length} field(s) changed by ${me.fullName}.`,
    p_link: `/partners/${me.partnerId}`, p_entity_type: "Partner", p_entity_id: me.partnerId, p_dedupe: `partner-change-${row.id}`,
  })));
  revalidatePath("/portal/account");
  return { ok: true, data: undefined };
}

export async function withdrawPartnerChange(id: string): Promise<ActionResult> {
  const me = await portalAdmin();
  if (me.portalRole !== "ADMIN") return { ok: false, error: "Only your portal admin can do this." };
  await supabaseAdmin().from("partner_change_request").update({ status: "WITHDRAWN", decidedAt: new Date().toISOString() })
    .eq("id", id).eq("partnerId", me.partnerId!).eq("status", "PENDING");
  revalidatePath("/portal/account");
  return { ok: true, data: undefined };
}

export async function getPendingPartnerChange(partnerId: string): Promise<PartnerChangeRequest | null> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return null;
  const { data } = await supabaseAdmin().from("partner_change_request").select("*").eq("partnerId", partnerId).eq("status", "PENDING").maybeSingle();
  return data as PartnerChangeRequest | null;
}

export async function decidePartnerChange(id: string, approve: boolean, note: string): Promise<ActionResult> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return { ok: false, error: "Only an administrator can decide this." };
  if (!approve && !note.trim()) return { ok: false, error: "Give a reason for rejecting it." };

  const admin = supabaseAdmin();
  // Claimed first, so two administrators cannot both apply it.
  const { data } = await admin.from("partner_change_request")
    .update({ status: approve ? "APPROVED" : "REJECTED", decidedById: me.id, decidedByName: me.fullName, decidedAt: new Date().toISOString(), decisionNote: note.trim() || null })
    .eq("id", id).eq("status", "PENDING").select("*").maybeSingle();
  const request = data as PartnerChangeRequest | null;
  if (!request) return { ok: false, error: "This request has already been decided." };

  if (approve) {
    const values = Object.fromEntries(Object.entries(request.changes).map(([field, c]) => {
      const to = c!.to;
      return [field, field === "email" || field === "phone" || field === "website" || field === "territory" || field === "taxNumber" ? to || null : to];
    }));
    try {
      await updateRecord("partner", request.partnerId, values, "Partner", me.id);
    } catch (err) {
      // Nothing changed on the partner, so the request goes back to waiting.
      await admin.from("activity_event").insert({ category: "SYSTEM", action: "PARTNER_CHANGE_APPLY_FAILED", outcome: "FAILED", summary: `Could not apply partner change ${id}`, actorId: me.id, actorName: me.fullName, entityType: "Partner", entityId: request.partnerId });
      await admin.from("partner_change_request").update({ status: "PENDING", decidedById: null, decidedByName: null, decidedAt: null, decisionNote: null }).eq("id", id);
      return { ok: false, error: err instanceof Error ? err.message : "Could not apply the change." };
    }
  }

  await tellPartner(request, approve, note.trim());
  revalidatePath(`/partners/${request.partnerId}`);
  revalidatePath("/approvals");
  revalidatePath("/portal/account");
  return { ok: true, data: undefined };
}

/** Portal logins have no bell, so the requester is told by email. */
async function tellPartner(request: PartnerChangeRequest, approved: boolean, note: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !request.requestedById) return;
  const { data: user } = await supabaseAdmin().from("app_user").select("email").eq("id", request.requestedById).maybeSingle();
  const to = user?.email as string | undefined;
  if (!to || isReservedAddress(to)) return;
  const text = approved
    ? "Your profile change has been approved and is now live on your partner account."
    : `Your profile change was not approved.\n\nReason: ${note}`;
  await new Resend(key, "Partner change decision").emails.send({
    from: process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>",
    to,
    subject: `Your profile change was ${approved ? "approved" : "not approved"}`,
    text,
  }, { entityType: "Partner", entityId: request.partnerId }).catch(() => undefined);
}
