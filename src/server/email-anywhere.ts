"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requireUser, can, type SessionUser as AuthedUser } from "@/lib/authz";
import { describeInvalid } from "@/lib/form-errors";
import { sanitizeRichText, richTextToPlain } from "@/lib/rich-text";
import { isReservedAddress } from "@/lib/notification-mailer";
import { renderDocumentEmail, brandingFromSettings, emailSettingsFromRow, EMAIL_SETTINGS_ID } from "@/lib/email-template";
import { DAILY_SEND_LIMIT, EMAIL_ATTACHMENT_LIMIT, EMAIL_SCREENS, fillEmailPlaceholders, isEmailScreen, type EmailScreen } from "@/lib/email-screens";
import type { ActionResult } from "./partners";

/**
 * Email from any record's page.
 *
 * Settings -> Email on screens says, per kind of record, whether its page
 * shows an Email button and which roles may use it (none listed = anyone who
 * can work on that kind of record). The message goes out from one of the
 * approved Sender addresses (the mail provider sends only from the verified
 * domain), with reply-to, CC, BCC and attachments; it is logged against the
 * record, its files are kept as the record's documents, and an email to a
 * prospect counts as outreach.
 *
 * Attachments are uploaded by the browser straight to private storage with a
 * one-time link (prepareEmailUpload), because a request to the app is capped
 * at 4 MB; the mail provider then fetches each file from a short-lived link.
 */

const BUCKET = "documents";
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export interface EmailScreenSetting {
  entityType: EmailScreen;
  enabled: boolean;
  roleIds: string[];
  defaultSenderId: string | null;
  defaultTemplateId: string | null;
}

async function readSetting(entityType: EmailScreen): Promise<EmailScreenSetting> {
  const { data } = await supabaseAdmin().from("email_screen_setting").select("*").eq("entityType", entityType).maybeSingle();
  return {
    entityType,
    enabled: Boolean(data?.enabled),
    roleIds: (data?.roleIds as string[] | null) ?? [],
    defaultSenderId: (data?.defaultSenderId as string | null) ?? null,
    defaultTemplateId: (data?.defaultTemplateId as string | null) ?? null,
  };
}

/** Whether this person may email from this kind of record's page. */
async function mayUse(me: AuthedUser, setting: EmailScreenSetting): Promise<boolean> {
  if (!setting.enabled) return false;
  if (!setting.roleIds.length) return can(me, EMAIL_SCREENS[setting.entityType].permission);
  if (can(me, PERMISSIONS.ADMIN)) return true;
  const { data } = await supabaseAdmin().from("app_user").select("\"roleId\"").eq("id", me.id).maybeSingle();
  return Boolean(data?.roleId && setting.roleIds.includes(String(data.roleId)));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function listEmailScreenSettings() {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) throw new Error(auth.error);
  const db = supabaseAdmin();
  const [settings, roles, senders, templates] = await Promise.all([
    db.from("email_screen_setting").select("*"),
    db.from("security_role").select("id, name").eq("active", true).not("name", "in", '("Partner","Customer")').order("name"),
    db.from("email_sender").select("id, label, \"fromAddress\"").eq("active", true).order("label"),
    db.from("email_template").select("id, name").eq("active", true).order("name"),
  ]);
  const byType = new Map((settings.data ?? []).map((s) => [String(s.entityType), s]));
  return {
    screens: (Object.keys(EMAIL_SCREENS) as EmailScreen[]).map((t) => {
      const s = byType.get(t);
      return { entityType: t, label: EMAIL_SCREENS[t].label, enabled: Boolean(s?.enabled), roleIds: (s?.roleIds as string[] | null) ?? [], defaultSenderId: (s?.defaultSenderId as string | null) ?? null, defaultTemplateId: (s?.defaultTemplateId as string | null) ?? null };
    }),
    roles: (roles.data ?? []) as { id: string; name: string }[],
    senders: (senders.data ?? []) as { id: string; label: string; fromAddress: string }[],
    templates: (templates.data ?? []) as { id: string; name: string }[],
  };
}

const settingSchema = z.object({
  entityType: z.string().refine(isEmailScreen, "Record type: choose one of the options."),
  enabled: z.boolean(),
  roleIds: z.array(z.string().uuid()).max(50),
  defaultSenderId: z.string().uuid().nullable().or(z.literal("").transform(() => null)),
  defaultTemplateId: z.string().uuid().nullable().or(z.literal("").transform(() => null)),
});

export async function saveEmailScreenSetting(input: z.input<typeof settingSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const parsed = settingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error) };
  const { error } = await supabaseAdmin().from("email_screen_setting").upsert({ ...parsed.data, updatedAt: new Date().toISOString(), updatedById: auth.user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings/email-screens");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// The record: may this person see it, and who can it be sent to
// ---------------------------------------------------------------------------

interface Suggestion { email: string; label: string; optedOut?: boolean }
interface RecordInfo { name: string; suggestions: Suggestion[]; values: Record<string, string> }

const first = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const joined = (...p: (string | null | undefined)[]) => p.filter(Boolean).join(" ").trim();

/** Reads the record as the person (row-level security decides) and lists its addresses. */
async function loadRecord(entityType: EmailScreen, id: string, me: AuthedUser): Promise<RecordInfo | null> {
  const db = await supabaseServer();
  switch (entityType) {
    case "Prospect": {
      const { data } = await db.from("prospect").select("\"businessName\", emails:prospect_email ( email, \"isPrimary\" ), people:prospect_person ( name, role, email, \"personalEmail\", \"isPrimary\" )").eq("id", id).maybeSingle();
      if (!data) return null;
      const people = (data.people ?? []) as { name: string; role: string | null; email: string | null; personalEmail: string | null; isPrimary: boolean }[];
      const main = people.find((p) => p.isPrimary) ?? people[0];
      return {
        name: String(data.businessName),
        suggestions: [
          ...people.flatMap((p) => [p.email && { email: p.email, label: `${p.name}${p.role ? `, ${p.role}` : ""}` }, p.personalEmail && { email: p.personalEmail, label: `${p.name} (personal)` }].filter(Boolean) as Suggestion[]),
          ...((data.emails ?? []) as { email: string }[]).map((e) => ({ email: e.email, label: String(data.businessName) })),
        ],
        values: { firstName: main ? first(main.name) : "", fullName: main?.name ?? "", company: String(data.businessName) },
      };
    }
    case "Lead": {
      const { data } = await db.from("lead").select("\"firstName\", \"lastName\", \"companyName\", email").eq("id", id).maybeSingle();
      if (!data) return null;
      const full = joined(data.firstName, data.lastName === "—" ? "" : data.lastName);
      return { name: full || String(data.companyName ?? "Lead"), suggestions: data.email ? [{ email: data.email, label: full }] : [], values: { firstName: data.firstName ?? "", fullName: full, company: data.companyName ?? "" } };
    }
    case "Contact": {
      const { data } = await db.from("contact").select("\"firstName\", \"lastName\", email, \"emailOptOut\", account ( name )").eq("id", id).maybeSingle();
      if (!data) return null;
      const full = joined(data.firstName, data.lastName);
      const company = (one(data.account) as { name?: string } | null)?.name ?? "";
      return { name: full, suggestions: data.email ? [{ email: data.email, label: full, optedOut: Boolean(data.emailOptOut) }] : [], values: { firstName: data.firstName ?? "", fullName: full, company } };
    }
    case "Case": {
      const { data } = await db.from("support_case").select("\"caseNumber\", subject, contact:contact ( \"firstName\", \"lastName\", email, \"emailOptOut\" ), account:account ( name )").eq("id", id).maybeSingle();
      if (!data) return null;
      const c = one(data.contact) as { firstName: string; lastName: string; email: string | null; emailOptOut: boolean } | null;
      const full = c ? joined(c.firstName, c.lastName) : "";
      return {
        name: `${data.caseNumber}: ${data.subject}`,
        suggestions: c?.email ? [{ email: c.email, label: full, optedOut: Boolean(c.emailOptOut) }] : [],
        values: { firstName: c?.firstName ?? "", fullName: full, company: (one(data.account) as { name?: string } | null)?.name ?? "" },
      };
    }
    case "Partner": {
      const { data } = await db.from("partner").select("\"displayName\", email, contact:contact ( \"firstName\", \"lastName\", email )").eq("id", id).maybeSingle();
      if (!data) return null;
      const c = one(data.contact) as { firstName: string; lastName: string; email: string | null } | null;
      return {
        name: String(data.displayName),
        suggestions: [c?.email && { email: c.email, label: joined(c.firstName, c.lastName) }, data.email && { email: data.email, label: String(data.displayName) }].filter(Boolean) as Suggestion[],
        values: { firstName: c?.firstName ?? "", fullName: c ? joined(c.firstName, c.lastName) : "", company: String(data.displayName) },
      };
    }
    case "User": {
      if (!can(me, PERMISSIONS.ADMIN)) return null;
      const { data } = await supabaseAdmin().from("app_user").select("\"fullName\", email, \"notificationEmail\"").eq("id", id).maybeSingle();
      if (!data) return null;
      return {
        name: String(data.fullName),
        suggestions: [{ email: data.email, label: String(data.fullName) }, ...(data.notificationEmail && data.notificationEmail !== data.email ? [{ email: data.notificationEmail, label: `${data.fullName} (notifications)` }] : [])],
        values: { firstName: first(String(data.fullName)), fullName: String(data.fullName), company: "" },
      };
    }
  }
}

/** Everything the Email window on a record's page needs; null when it is not offered here. */
export async function getEmailComposeContext(entityType: string, entityId: string) {
  if (!isEmailScreen(entityType)) return null;
  const me = await requireUser();
  const setting = await readSetting(entityType);
  if (!(await mayUse(me, setting))) return null;
  const record = await loadRecord(entityType, entityId, me);
  if (!record) return null;
  const admin = supabaseAdmin();
  const [senders, templates, documents] = await Promise.all([
    admin.from("email_sender").select("id, label, \"fromName\", \"fromAddress\", \"replyTo\", \"isDefault\"").eq("active", true).order("label"),
    admin.from("email_template").select("id, name, subject, body").eq("active", true).order("name"),
    (await supabaseServer()).from("document").select("id, \"fileName\", \"fileSizeBytes\", \"mimeType\"").eq("relatedEntityType", entityType).eq("relatedEntityId", entityId).is("deletedAt", null).order("createdAt", { ascending: false }).limit(50),
  ]);
  const senderList = (senders.data ?? []) as { id: string; label: string; fromName: string | null; fromAddress: string; replyTo: string | null; isDefault: boolean }[];
  return {
    entityType, entityId, recordName: record.name,
    suggestions: record.suggestions.filter((s, i, all) => all.findIndex((x) => x.email.toLowerCase() === s.email.toLowerCase()) === i),
    values: { ...record.values, myName: me.fullName, myTitle: me.jobTitle ?? "" },
    senders: senderList,
    defaultSenderId: setting.defaultSenderId && senderList.some((s) => s.id === setting.defaultSenderId) ? setting.defaultSenderId : senderList.find((s) => s.isDefault)?.id ?? senderList[0]?.id ?? null,
    templates: (templates.data ?? []) as { id: string; name: string; subject: string; body: string }[],
    defaultTemplateId: setting.defaultTemplateId,
    documents: (documents.data ?? []) as { id: string; fileName: string; fileSizeBytes: number | null; mimeType: string | null }[],
    myEmail: me.email,
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** A one-time link to upload one attachment straight to private storage. */
export async function prepareEmailUpload(entityType: string, entityId: string, fileName: string, size: number): Promise<ActionResult<{ path: string; token: string }>> {
  if (!isEmailScreen(entityType)) return { ok: false, error: "That record cannot send email." };
  const me = await requireUser();
  if (!(await mayUse(me, await readSetting(entityType)))) return { ok: false, error: "Email is not switched on for you here." };
  if (!(await loadRecord(entityType, entityId, me))) return { ok: false, error: "That record is not available to you." };
  if (size > EMAIL_ATTACHMENT_LIMIT) return { ok: false, error: `${fileName} is over the 10 MB limit for attachments.` };
  const safe = fileName.replace(/[^\w.\- ]+/g, "_").slice(-120) || "file";
  const path = `${entityType}/${entityId}/email/${randomUUID()}-${safe}`;
  const { data, error } = await supabaseAdmin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: `Could not prepare the upload: ${error?.message ?? "no link"}` };
  return { ok: true, data: { path, token: data.token } };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const address = z.string().trim().toLowerCase().email();
const sendSchema = z.object({
  entityType: z.string().refine(isEmailScreen, "Record type: choose one of the options."),
  entityId: z.string().uuid(),
  senderId: z.string().uuid({ message: "From: choose one of the sender addresses." }),
  replyTo: z.string().trim().email("Reply-to: enter a valid email address.").optional().nullable().or(z.literal("").transform(() => null)),
  to: z.array(address).min(1, "To is required.").max(50),
  cc: z.array(address).max(50).default([]),
  bcc: z.array(address).max(50).default([]),
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().max(200_000),
  uploads: z.array(z.object({ path: z.string().max(500), fileName: z.string().max(300), mimeType: z.string().max(150).optional().nullable(), size: z.number().int().min(0) })).max(20).default([]),
  documentIds: z.array(z.string().uuid()).max(20).default([]),
});

export async function sendRecordEmail(input: z.input<typeof sendSchema>): Promise<ActionResult<{ emailId: string; delivered: boolean; note: string | null }>> {
  const me = await requireUser();
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const d = parsed.data;
  const entityType = d.entityType as EmailScreen;
  if (!(await mayUse(me, await readSetting(entityType)))) return { ok: false, error: "Email is not switched on for you here." };
  const record = await loadRecord(entityType, d.entityId, me);
  if (!record) return { ok: false, error: "That record is not available to you." };
  const body = sanitizeRichText(d.bodyHtml);
  if (!body) return { ok: false, error: "Message is required." };
  const admin = supabaseAdmin();

  // Opted-out contacts are never emailed.
  const everyone = [...new Set([...d.to, ...d.cc, ...d.bcc])];
  const { data: optedOut } = await admin.from("contact").select("email").in("email", everyone).eq("emailOptOut", true);
  if (optedOut?.length) return { ok: false, error: `${optedOut.map((o) => o.email).join(", ")} asked not to be emailed. Take them off the email.` };

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count: today } = await admin.from("email").select("id", { count: "exact", head: true }).eq("sentById", me.id).gte("sentReceivedAt", since);
  if ((today ?? 0) >= DAILY_SEND_LIMIT) return { ok: false, error: `You have sent ${DAILY_SEND_LIMIT} emails in the last 24 hours, the daily limit. Try again later.` };

  const { data: sender } = await admin.from("email_sender").select("\"fromName\", \"fromAddress\", \"replyTo\"").eq("id", d.senderId).eq("active", true).maybeSingle();
  if (!sender) return { ok: false, error: "From: choose one of the sender addresses." };
  const from = sender.fromName ? `${sender.fromName} <${sender.fromAddress}>` : String(sender.fromAddress);
  const replyTo = d.replyTo || sender.replyTo || me.email;

  // Attachments: this email's uploads, and documents already on the record.
  const attachments: { fileName: string; mimeType: string | null; size: number; storagePath: string; documentId: string | null }[] = [];
  for (const u of d.uploads) {
    if (!u.path.startsWith(`${entityType}/${d.entityId}/email/`)) return { ok: false, error: "An attachment does not belong to this record." };
    attachments.push({ fileName: u.fileName, mimeType: u.mimeType ?? null, size: u.size, storagePath: u.path, documentId: null });
  }
  if (d.documentIds.length) {
    const { data: docs } = await (await supabaseServer()).from("document").select("id, \"fileName\", \"mimeType\", \"fileSizeBytes\", \"storageUrl\"").in("id", d.documentIds).eq("relatedEntityType", entityType).eq("relatedEntityId", d.entityId).is("deletedAt", null);
    for (const doc of docs ?? []) attachments.push({ fileName: doc.fileName, mimeType: doc.mimeType, size: Number(doc.fileSizeBytes ?? 0), storagePath: doc.storageUrl, documentId: doc.id });
  }
  if (attachments.reduce((s, a) => s + a.size, 0) > EMAIL_ATTACHMENT_LIMIT) return { ok: false, error: "Attachments come to more than 10 MB. Take some off." };
  const links: { filename: string; path: string }[] = [];
  for (const a of attachments) {
    const { data: link, error } = await admin.storage.from(BUCKET).createSignedUrl(a.storagePath, 60 * 30);
    if (error || !link) return { ok: false, error: `${a.fileName} could not be found. Attach it again.` };
    links.push({ filename: a.fileName, path: link.signedUrl });
  }

  // The message, in the company's email layout.
  const { data: settings } = await admin.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const values = { ...record.values, myName: me.fullName, myTitle: me.jobTitle ?? "" };
  const subject = fillEmailPlaceholders(d.subject, values, false);
  const { html, text } = renderDocumentEmail({
    branding, documentTitle: subject, message: "", messageHtml: fillEmailPlaceholders(body, values, true), summary: [],
    senderName: me.fullName, senderTitle: me.jobTitle,
  });

  const emailId = randomUUID();
  const now = new Date().toISOString();
  const { error: logError } = await admin.from("email").insert({
    id: emailId, updatedAt: now, direction: "OUTBOUND", subject, fromAddress: from, toAddresses: d.to, ccAddresses: d.cc.length ? d.cc : null,
    bccAddresses: d.bcc.length ? d.bcc : null, replyTo, bodyHtml: html, bodyText: text || richTextToPlain(body), relatedEntityType: entityType,
    relatedEntityId: d.entityId, sentReceivedAt: now, status: "DRAFT", hasAttachments: attachments.length > 0, sentById: me.id,
  });
  if (logError) return { ok: false, error: logError.message };

  // Files sent are kept on the record, and listed against the email.
  for (const a of attachments) {
    let documentId = a.documentId;
    if (!documentId) {
      const { data: doc } = await admin.from("document").insert({
        id: randomUUID(), fileName: a.fileName, storageUrl: a.storagePath, mimeType: a.mimeType ?? "application/octet-stream", fileSizeBytes: a.size,
        category: "Email attachment", relatedEntityType: entityType, relatedEntityId: d.entityId, uploadedById: me.id, updatedAt: now,
      }).select("id").single();
      documentId = doc?.id ?? null;
    }
    await admin.from("email_attachment").insert({ emailId, documentId, fileName: a.fileName, mimeType: a.mimeType, fileSizeBytes: a.size });
  }

  // Test addresses and a server without email set up record the email but send nothing.
  const key = process.env.RESEND_API_KEY;
  const reserved = everyone.every((e) => isReservedAddress(e));
  let delivered = false;
  let note: string | null = null;
  if (!key || reserved) {
    note = !key ? "Email is not set up on this server (RESEND_API_KEY), so it was recorded but not sent." : "Test addresses are never mailed; it was recorded but not sent.";
    await admin.from("email").update({ status: "FAILED", updatedAt: new Date().toISOString() }).eq("id", emailId);
  } else {
    const sent = await new Resend(key).emails.send({
      from, to: d.to, cc: d.cc.length ? d.cc : undefined, bcc: d.bcc.length ? d.bcc : undefined, replyTo, subject, html, text,
      attachments: links.length ? links : undefined,
    });
    await admin.from("email").update(sent.error ? { status: "FAILED", updatedAt: new Date().toISOString() } : { status: "SENT", messageId: sent.data?.id ?? null, updatedAt: new Date().toISOString() }).eq("id", emailId);
    if (sent.error) return { ok: false, error: `Could not send: ${sent.error.message}` };
    delivered = true;
  }

  // An email to a prospect is outreach: logged, and counted in its campaign when it has exactly one.
  if (entityType === "Prospect") {
    const { data: entries } = await admin.from("prospect_campaign_entry").select("\"campaignId\"").eq("prospectId", d.entityId);
    const campaignId = entries?.length === 1 ? entries[0].campaignId : null;
    await admin.from("prospect_activity").insert({ prospectId: d.entityId, campaignId, type: "EMAIL_SENT", channel: "business_email", content: `Subject: ${subject}`, actorId: me.id });
    if (campaignId) await admin.rpc("prospect_campaign_touch", { p_campaign: campaignId, p_prospect: d.entityId, p_at: now });
  }

  revalidatePath(EMAIL_SCREENS[entityType].path(d.entityId));
  return { ok: true, data: { emailId, delivered, note } };
}

/** The emails sent from a record, newest first, for its Emails panel. */
export async function listRecordEmails(entityType: string, entityId: string) {
  if (!isEmailScreen(entityType)) return [];
  const me = await requireUser();
  if (!(await loadRecord(entityType, entityId, me))) return [];
  const { data } = await supabaseAdmin().from("email")
    .select("id, subject, \"fromAddress\", \"toAddresses\", \"ccAddresses\", status, \"sentReceivedAt\", \"bodyText\", sender:app_user!email_sentById_fkey ( \"fullName\" ), attachments:email_attachment ( \"fileName\", \"documentId\" )")
    .eq("relatedEntityType", entityType).eq("relatedEntityId", entityId).eq("direction", "OUTBOUND")
    .order("sentReceivedAt", { ascending: false }).limit(50);
  return (data ?? []).map((e) => ({
    id: e.id as string, subject: e.subject as string, from: e.fromAddress as string, to: (e.toAddresses as string[]) ?? [], cc: (e.ccAddresses as string[] | null) ?? [],
    status: e.status as string, at: e.sentReceivedAt as string, preview: String(e.bodyText ?? "").slice(0, 300),
    sender: (one(e.sender) as { fullName?: string } | null)?.fullName ?? null,
    attachments: ((e.attachments ?? []) as { fileName: string; documentId: string | null }[]),
  }));
}
