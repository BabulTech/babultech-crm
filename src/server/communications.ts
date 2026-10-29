"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { authorize, requireUser, can, canAny, PERMISSIONS } from "@/lib/authz";
import { prepareLeadEmails, verifiedDomain, type Audience, type SendResult } from "@/lib/lead-mailer";
import { queueJob } from "@/lib/jobs";
import { loadProspectRecipients } from "@/lib/prospect-recipients";
import { emailScreenAccess } from "./email-anywhere";
import type { ActionResult } from "./partners";

/**
 * Communication: email templates, sender addresses, mass email to any kind of
 * person, and consent.
 */

const AUDIENCES = ["Lead", "Contact", "CampaignMember", "Prospect"] as const;

/** The permission that emails each kind of person. */
function writePermission(audience: Audience): string {
  return audience === "Contact" ? PERMISSIONS.ACCOUNT_WRITE : audience === "Prospect" ? PERMISSIONS.PROSPECT_WRITE : PERMISSIONS.LEAD_WRITE;
}

/**
 * Whether this person may mass-email this kind of person: the same switch and
 * roles as the record pages' Emails panel (Settings -> Email on screens).
 */
async function mayMassEmail(audience: Audience): Promise<boolean> {
  return (await emailScreenAccess(audience)) !== null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  id: string;
  name: string;
  audience: string;
  subject: string;
  body: string;
  active: boolean;
  createdById: string | null;
  createdByName: string | null;
  mine: boolean;
}

export async function listTemplates(audience?: Audience): Promise<EmailTemplate[]> {
  const me = await requireUser();
  const db = await supabaseServer();
  let query = db
    .from("email_template")
    .select("id, name, audience, subject, body, active, createdById, createdBy:app_user!email_template_createdById_fkey ( fullName )")
    .order("name");
  if (audience) query = query.in("audience", ["ANY", audience]).eq("active", true);
  const { data } = await query;
  return (data ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    audience: t.audience as string,
    subject: t.subject as string,
    body: t.body as string,
    active: Boolean(t.active),
    createdById: (t.createdById as string | null) ?? null,
    createdByName: ((Array.isArray(t.createdBy) ? t.createdBy[0] : t.createdBy) as { fullName?: string } | null)?.fullName ?? null,
    mine: t.createdById === me.id,
  }));
}

const templateSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(1, "Give the template a name.").max(150),
  audience: z.enum(["ANY", ...AUDIENCES]),
  subject: z.string().trim().min(1, "The template needs a subject.").max(300),
  body: z.string().trim().min(1, "The template needs a message.").max(20000),
  active: z.boolean(),
});

export async function saveTemplate(input: z.infer<typeof templateSchema>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!canAny(auth.user, PERMISSIONS.LEAD_WRITE, PERMISSIONS.ACCOUNT_WRITE)) {
    return { ok: false, error: "Only people who send email can keep templates." };
  }
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the template." };
  const { id, ...row } = parsed.data;
  const db = await supabaseServer();
  const { data, error } = id
    ? await db.from("email_template").update({ ...row, updatedAt: new Date().toISOString() }).eq("id", id).select("id")
    : await db.from("email_template").insert({ ...row, createdById: auth.user.id }).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Only whoever wrote a template, or an administrator, can change it." };
  revalidatePath("/email/templates");
  return { ok: true, data: { id: data[0].id as string } };
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  const db = await supabaseServer();
  const { data, error } = await db.from("email_template").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Only whoever wrote a template, or an administrator, can delete it." };
  revalidatePath("/email/templates");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Sender addresses
// ---------------------------------------------------------------------------

export interface EmailSender {
  id: string;
  label: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  isDefault: boolean;
  active: boolean;
}

/**
 * The sender addresses. The first time anyone asks, Sales and Support are
 * set up on the verified domain, so there is something to choose from.
 */
export async function listSenders(): Promise<{ senders: EmailSender[]; domain: string | null }> {
  await requireUser();
  const domain = verifiedDomain();
  const db = await supabaseServer();
  let { data } = await db.from("email_sender").select("*").order("label");
  if ((data ?? []).length === 0 && domain) {
    const { data: company } = await supabaseAdmin().from("company_setting").select("companyName").eq("id", true).maybeSingle();
    const name = (company?.companyName as string | null) ?? "BabulTech";
    // Every row names the same fields: a multi-row insert refuses rows that differ.
    const { error } = await supabaseAdmin().from("email_sender").insert([
      { label: "Sales", fromName: `${name} Sales`, fromAddress: `sales@${domain}`, isDefault: true },
      { label: "Support", fromName: `${name} Support`, fromAddress: `support@${domain}`, isDefault: false },
    ]);
    if (error) console.error(`Could not set up the default senders: ${error.message}`);
    ({ data } = await db.from("email_sender").select("*").order("label"));
  }
  return { senders: (data ?? []) as EmailSender[], domain };
}

const senderSchema = z.object({
  id: z.string().uuid().nullable(),
  label: z.string().trim().min(1, "Give it a label, such as Sales.").max(80),
  fromName: z.string().trim().min(1, "Say whose name it shows.").max(120),
  fromAddress: z.string().trim().toLowerCase().email("That is not an email address.").max(255),
  replyTo: z.string().trim().toLowerCase().email("The reply-to is not an email address.").max(255).or(z.literal("")),
  isDefault: z.boolean(),
  active: z.boolean(),
});

export async function saveSender(input: z.infer<typeof senderSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = senderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the sender." };
  const { id, ...row } = parsed.data;
  const domain = verifiedDomain();
  if (row.fromAddress.split("@")[1] !== domain) {
    return { ok: false, error: `Use an address at ${domain ?? "the verified domain"} - the mail provider only sends for that domain.` };
  }
  const db = await supabaseServer();
  if (row.isDefault) await db.from("email_sender").update({ isDefault: false }).eq("isDefault", true);
  const values = { ...row, replyTo: row.replyTo || null, updatedAt: new Date().toISOString() };
  const { error } = id ? await db.from("email_sender").update(values).eq("id", id) : await db.from("email_sender").insert(values);
  if (error) return { ok: false, error: /duplicate/i.test(error.message) ? "That address is already a sender." : error.message };
  revalidatePath("/email/senders");
  return { ok: true, data: undefined };
}

export async function deleteSender(id: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };
  const db = await supabaseServer();
  const { error } = await db.from("email_sender").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/email/senders");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Who a send goes to
// ---------------------------------------------------------------------------

export interface Recipient {
  id: string;
  name: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  /** Why they will be left out, or null. */
  skip: string | null;
  /** Contacts only: whether they agreed to marketing. */
  consented: boolean | null;
}

async function loadPeople(audience: Audience, ids: string[]) {
  const db = await supabaseServer();
  if (audience === "Lead") {
    const { data } = await db.from("lead").select("id, firstName, lastName, companyName, email").in("id", ids).is("deletedAt", null);
    return (data ?? []).map((p) => ({ ...p, consented: null as boolean | null, optOut: false }));
  }
  if (audience === "Contact") {
    const { data } = await db
      .from("contact")
      .select("id, firstName, lastName, email, communicationConsent, emailOptOut, account ( name )")
      .in("id", ids)
      .is("deletedAt", null);
    return (data ?? []).map((c) => ({
      id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email,
      companyName: ((Array.isArray(c.account) ? c.account[0] : c.account) as { name?: string } | null)?.name ?? null,
      consented: Boolean(c.communicationConsent), optOut: Boolean(c.emailOptOut),
    }));
  }
  if (audience === "Prospect") {
    return (await loadProspectRecipients(db, ids)).map((p) => ({ ...p, consented: null as boolean | null, optOut: p.archived }));
  }
  const { data } = await db
    .from("campaign_member")
    .select("id, firstName, lastName, companyName, email, emailOptOut, emailBounced")
    .in("id", ids)
    .is("deletedAt", null);
  return (data ?? []).map((m) => ({ ...m, consented: null as boolean | null, optOut: Boolean(m.emailOptOut) || Boolean(m.emailBounced) }));
}

/** The people chosen, with who will be left out and why. */
export async function getAudience(audience: Audience, ids: string[], consentedOnly: boolean): Promise<Recipient[]> {
  await requireUser();
  const clean = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 2000);
  if (!clean.length) return [];
  const people = await loadPeople(audience, clean);
  const db = await supabaseServer();
  const addresses = people.map((p) => (p.email as string | null)?.toLowerCase().trim()).filter(Boolean) as string[];
  const { data: suppressed } = await db.from("email_suppression").select("email, reason").in("email", addresses.length ? addresses : ["-"]);
  const reasons = new Map((suppressed ?? []).map((s) => [s.email as string, s.reason as string]));
  const seen = new Set<string>();
  return people
    .map((p) => {
      const email = (p.email as string | null)?.toLowerCase().trim() ?? null;
      let skip: string | null = null;
      if (!email) skip = "No email address";
      else if (p.optOut) skip = "Asked not to be emailed";
      else if (reasons.has(email)) {
        const r = reasons.get(email)!;
        skip = r === "UNSUBSCRIBED" ? "Unsubscribed" : r === "BOUNCED" ? "Address bounced" : "Reported spam";
      } else if (audience === "Contact" && consentedOnly && !p.consented) skip = "Has not agreed to marketing";
      else if (seen.has(email)) skip = "Same address as someone else here";
      if (email && !skip) seen.add(email);
      return {
        id: p.id as string,
        name: `${p.firstName ?? ""} ${p.lastName && p.lastName !== "-" ? p.lastName : ""}`.trim(),
        firstName: (p.firstName as string) ?? "",
        lastName: (p.lastName as string | null) ?? null,
        companyName: (p.companyName as string | null) ?? null,
        email: (p.email as string | null) ?? null,
        skip,
        consented: p.consented,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const sendSchema = z.object({
  audience: z.enum(AUDIENCES),
  ids: z.array(z.string().uuid()).min(1, "Choose at least one person.").max(2000),
  subject: z.string().trim().min(1, "The email needs a subject.").max(300),
  bodyText: z.string().trim().min(1, "The email needs a message.").max(20000),
  senderId: z.string().uuid().nullable(),
  fromName: z.string().trim().max(120).optional().or(z.literal("")),
  replyTo: z.string().trim().max(255).optional().or(z.literal("")),
  templateId: z.string().uuid().nullable(),
  consentedOnly: z.boolean(),
});

/** Emails the chosen people; the messages go out from a background job. */
export async function sendMassEmail(input: z.infer<typeof sendSchema>): Promise<ActionResult<SendResult>> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the email." };
  const d = parsed.data;
  const auth = await authorize(writePermission(d.audience));
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!(await mayMassEmail(d.audience))) return { ok: false, error: "Email is switched off for you here. An administrator can change it in Settings, Email on screens." };

  // Worked out again here rather than trusted from the screen.
  const audience = await getAudience(d.audience, d.ids, d.consentedOnly);
  const sendable = audience.filter((a) => !a.skip);
  let sender: EmailSender | null = null;
  if (d.senderId) {
    const db = await supabaseServer();
    const { data } = await db.from("email_sender").select("*").eq("id", d.senderId).eq("active", true).maybeSingle();
    if (!data) return { ok: false, error: "That sender address is not available." };
    sender = data as EmailSender;
  }

  const result = await prepareLeadEmails({
    leads: sendable.map((a) => ({ id: a.id, firstName: a.firstName, lastName: a.lastName, companyName: a.companyName, email: a.email })),
    subject: d.subject,
    bodyText: d.bodyText,
    fromName: d.fromName || sender?.fromName || null,
    replyTo: d.replyTo || sender?.replyTo || null,
    sentById: auth.user.id,
    db: await supabaseServer(),
    audience: d.audience,
    fromAddress: sender?.fromAddress ?? null,
    senderId: sender?.id ?? null,
    templateId: d.templateId,
  });
  if (!result.ok) return result;

  const skippedHere = audience.filter((a) => a.skip).map((a) => `${a.name}: ${a.skip!.toLowerCase()}`);
  if (skippedHere.length) {
    await supabaseAdmin()
      .from("email_batch")
      .update({
        skippedCount: result.data.skipped + skippedHere.length,
        skippedReasons: [...skippedHere, ...result.data.skippedReasons].slice(0, 50),
      })
      .eq("id", result.data.batchId);
  }
  await queueJob({
    jobType: "lead_email",
    title: `Email: ${d.subject}`,
    payload: { batchId: result.data.batchId },
    progressTotal: result.data.queued,
    createdById: auth.user.id,
  });
  // Emailing a prospect is an outreach touch, as it is from the prospect's page.
  if (d.audience === "Prospect" && sendable.length) {
    const admin = supabaseAdmin();
    const { data: entries } = await admin.from("prospect_campaign_entry").select("\"prospectId\", \"campaignId\"").in("prospectId", sendable.map((a) => a.id));
    const campaigns = new Map<string, string[]>();
    for (const e of entries ?? []) campaigns.set(e.prospectId as string, [...(campaigns.get(e.prospectId as string) ?? []), e.campaignId as string]);
    const now = new Date().toISOString();
    await admin.from("prospect_activity").insert(sendable.map((a) => {
      const only = campaigns.get(a.id)?.length === 1 ? campaigns.get(a.id)![0] : null;
      return { prospectId: a.id, campaignId: only, type: "EMAIL_SENT", channel: "business_email", content: `Subject: ${d.subject} (sent to ${sendable.length})`, actorId: auth.user.id };
    }));
    for (const a of sendable) {
      const only = campaigns.get(a.id)?.length === 1 ? campaigns.get(a.id)![0] : null;
      if (only) await admin.rpc("prospect_campaign_touch", { p_campaign: only, p_prospect: a.id, p_at: now });
    }
  }
  revalidatePath("/leads/email/sends");
  return { ok: true, data: { ...result.data, skipped: result.data.skipped + skippedHere.length } };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** Marks a contact as not wanting email, or back as happy to receive it. */
export async function setContactEmailOptOut(contactId: string, optOut: boolean): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ACCOUNT_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };
  const db = await supabaseServer();
  const { data: contact } = await db.from("contact").select("id, email").eq("id", contactId).maybeSingle();
  if (!contact) return { ok: false, error: "That contact could not be found." };
  if (!contact.email) return { ok: false, error: "They have no email address." };
  const { error } = await supabaseAdmin().rpc("set_email_opt_out", {
    p_email: contact.email,
    p_opt_out: optOut,
    p_note: `${optOut ? "Opted out" : "Opted back in"} by ${auth.user.fullName}`,
  });
  if (error) return { ok: false, error: error.message };
  await supabaseAdmin().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "Contact", entityId: contactId, fieldName: "emailOptOut",
    oldValue: String(!optOut), newValue: String(optOut), changedById: auth.user.id, source: "UI", changedAt: new Date().toISOString(),
  });
  return { ok: true, data: undefined };
}

/** Whether someone may send to a kind of person at all, for the Email buttons. */
export async function canEmail(audience: Audience): Promise<boolean> {
  const me = await requireUser();
  return can(me, writePermission(audience)) && (await mayMassEmail(audience));
}
