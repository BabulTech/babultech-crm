"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";
import { PERMISSIONS, authorize } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { sanitizeRichText } from "@/lib/rich-text";
import { describeInvalid } from "@/lib/form-errors";
import { renderDocumentEmail, brandingFromSettings, emailSettingsFromRow, EMAIL_SETTINGS_ID } from "@/lib/email-template";
import { SYSTEM_EMAILS, fillPlaceholders, sampleValues, systemEmailDefault, type SystemEmailKey } from "@/lib/system-emails";
import type { ActionResult } from "./partners";

/**
 * Settings → System emails: the wording of the emails the CRM sends on its
 * own. Administrators only. A saved version replaces the default; resetting
 * deletes it. See src/lib/system-emails.ts.
 */

const KEYS = SYSTEM_EMAILS.map((e) => e.key) as [SystemEmailKey, ...SystemEmailKey[]];

const templateSchema = z.object({
  key: z.enum(KEYS),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(20_000),
});

/** Every system email, with the saved version where there is one. */
export async function listEmailTemplates() {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) throw new Error(auth.error);
  const { data } = await supabaseAdmin().from("system_email_template").select("key, subject, body, updatedAt, editor:app_user ( fullName )");
  const saved = new Map((data ?? []).map((r) => [String(r.key), r]));
  return SYSTEM_EMAILS.map((e) => {
    const row = saved.get(e.key);
    const editor = row ? (Array.isArray(row.editor) ? row.editor[0] : row.editor) as { fullName?: string } | null : null;
    return {
      ...e,
      defaultSubject: e.subject,
      defaultBody: e.body,
      subject: row ? String(row.subject) : e.subject,
      body: row ? String(row.body) : e.body,
      customised: Boolean(row),
      updatedAt: row ? String(row.updatedAt) : null,
      updatedBy: editor?.fullName ?? null,
    };
  });
}

export async function saveEmailTemplate(input: z.input<typeof templateSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const body = sanitizeRichText(parsed.data.body);
  if (!body) return { ok: false, error: "Message is required.", fieldErrors: { body: ["Message is required."] } };
  const { error } = await supabaseAdmin().from("system_email_template").upsert({
    key: parsed.data.key, subject: parsed.data.subject, body, updatedAt: new Date().toISOString(), updatedById: auth.user.id,
  });
  if (error) return { ok: false, error: error.message };
  await writeAudit({ entityType: "EmailTemplate", entityId: auth.user.id, fieldName: parsed.data.key, oldValue: null, newValue: "edited", changedById: auth.user.id }, supabaseAdmin()).catch(() => {});
  revalidatePath("/settings/email-templates");
  return { ok: true, data: undefined };
}

export async function resetEmailTemplate(key: SystemEmailKey): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  systemEmailDefault(key);
  const { error } = await supabaseAdmin().from("system_email_template").delete().eq("key", key);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings/email-templates");
  return { ok: true, data: undefined };
}

/** The email as it would arrive, with sample values, from what is in the editor now. */
async function render(key: SystemEmailKey, subject: string, body: string, sender: { fullName: string; jobTitle?: string | null }) {
  const { data: settings } = await supabaseAdmin().from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const values = sampleValues(key, branding.companyName);
  const signIn = "https://example.com/login";
  const summary = key === "CONTRACT_SIGNING"
    ? [{ label: "Position", value: values.position ?? "" }, { label: "From", value: "1 Nov 2026" }, { label: "To", value: "31 Oct 2027" }]
    : key.startsWith("PORTAL") || key.endsWith("PORTAL_WELCOME")
      ? [{ label: "Sign in at", value: signIn }, { label: "Your email", value: values.email }, { label: "Temporary password", value: "Sample-Passw0rd", emphasis: true }]
      : [{ label: "Your sign-in email", value: values.email, emphasis: true }, { label: "Sign in at", value: signIn }];
  const action = key === "CONTRACT_SIGNING" ? { label: "Read and sign", url: "https://example.com/sign/sample" }
    : key === "LOGIN_WELCOME" ? { label: "Choose my password", url: "https://example.com/reset-password/sample" }
    : key === "PASSWORD_RESET" ? { label: "Set a new password", url: "https://example.com/reset-password/sample" }
    : { label: "Sign in", url: signIn };
  const rendered = renderDocumentEmail({
    branding,
    documentTitle: systemEmailDefault(key).name,
    message: "",
    messageHtml: fillPlaceholders(sanitizeRichText(body) ?? "", values, true),
    summary,
    action,
    senderName: sender.fullName,
    senderTitle: sender.jobTitle ?? null,
  });
  return { subject: fillPlaceholders(subject, values, false), ...rendered };
}

export async function previewEmailTemplate(key: SystemEmailKey, subject: string, body: string): Promise<ActionResult<{ subject: string; html: string }>> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const r = await render(key, subject, body, auth.user);
  return { ok: true, data: { subject: r.subject, html: r.html } };
}

/** Sends what is in the editor to the signed-in administrator, with sample values. */
export async function sendEmailTemplateTest(key: SystemEmailKey, subject: string, body: string): Promise<ActionResult<{ to: string }>> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: "Email is not set up on this server (RESEND_API_KEY)." };
  const r = await render(key, subject, body, auth.user);
  const { error } = await new Resend(apiKey).emails.send({
    from: process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>",
    to: auth.user.email, subject: `[Test] ${r.subject}`, html: r.html, text: r.text,
  });
  if (error) return { ok: false, error: `Could not send: ${error.message}` };
  return { ok: true, data: { to: auth.user.email } };
}
