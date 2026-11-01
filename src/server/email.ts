"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Resend } from "@/lib/mail";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { one } from "@/lib/decimal";
// Plain, single-currency formatting: this goes to customers, and an approximate
// conversion at an internal rate has no place on a quote or an invoice.
import { formatMoneyPlain as formatMoney, formatDate } from "@/lib/utils";
import {
  renderDocumentEmail, fillTemplate, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID,
  type EmailBranding,
} from "@/lib/email-template";
import type { ActionResult } from "./partners";

/**
 * Sending quotations and invoices to customers.
 *
 * Every send is written to the `email` table whether or not the provider
 * accepted it, so "did we ever send this?" has an answer that does not depend
 * on the provider's dashboard. A failed send is recorded as FAILED rather than
 * dropped — silence is the worst outcome when someone is waiting on a quote.
 *
 * Resend is optional. Without RESEND_API_KEY the actions refuse with a message
 * naming what is missing rather than throwing, so the rest of the app runs on
 * a development machine with no mail configured.
 */

const FROM = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
const REPLY_TO = process.env.EMAIL_REPLY_TO;

function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key, "Document email") : null;
}

export async function isEmailConfigured(): Promise<boolean> {
  return Boolean(process.env.RESEND_API_KEY);
}

const SETTINGS_ID = EMAIL_SETTINGS_ID;

/**
 * Branding and templates, with defaults if the row is somehow missing.
 *
 * A send must not fail because a settings row was deleted, so every field has
 * a fallback rather than the query being treated as required.
 */
export async function getEmailSettings() {
  await requireUser();
  const db = await supabaseServer();

  const { data } = await db.from("email_settings").select("*").eq("id", SETTINGS_ID).maybeSingle();

  return emailSettingsFromRow(data);
}

async function getBranding(): Promise<EmailBranding> {
  return brandingFromSettings(await getEmailSettings());
}

/** The subject and body a compose form should open with, placeholders filled. */
export async function getDraftFor(
  kind: "quotation" | "invoice",
  values: Record<string, string>,
): Promise<{ subject: string; body: string }> {
  const s = await getEmailSettings();
  const merged = { ...values, companyName: s.companyName };

  return kind === "quotation"
    ? {
        subject: fillTemplate(s.quotationSubject, merged),
        body: fillTemplate(s.quotationBody, merged),
      }
    : {
        subject: fillTemplate(s.invoiceSubject, merged),
        body: fillTemplate(s.invoiceBody, merged),
      };
}

const settingsSchema = z.object({
  companyName: z.string().trim().min(1, "The company needs a name.").max(200),
  logoUrl: z.string().trim().url("That is not a valid URL.").or(z.literal("")).nullable(),
  websiteUrl: z.string().trim().url("That is not a valid URL.").or(z.literal("")).nullable(),
  supportEmail: z.string().trim().email().or(z.literal("")).nullable(),
  supportPhone: z.string().trim().max(50).nullable(),
  addressLine: z.string().trim().nullable(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour like #00B8A4."),
  brandColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour."),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour."),
  mutedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour."),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour."),
  quotationSubject: z.string().trim().min(1),
  quotationBody: z.string().trim().min(1),
  invoiceSubject: z.string().trim().min(1),
  invoiceBody: z.string().trim().min(1),
  emailFooter: z.string().trim(),
});

export async function saveEmailSettings(
  input: z.infer<typeof settingsSchema>,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) {
    return { ok: false, error: "Only an administrator can change email settings." };
  }

  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the values.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();

  const { error } = await db
    .from("email_settings")
    .update({
      ...d,
      logoUrl: d.logoUrl || null,
      websiteUrl: d.websiteUrl || null,
      supportEmail: d.supportEmail || null,
      supportPhone: d.supportPhone || null,
      addressLine: d.addressLine || null,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", SETTINGS_ID);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true, data: { id: SETTINGS_ID } };
}

const LOGO_BUCKET = "branding";
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Uploads a logo and returns its public URL.
 *
 * The bucket is public by design: an email client fetches the image with no
 * session, so a signed URL would expire and leave a broken image in every mail
 * already sent. Only branding lives here — customer documents stay private.
 *
 * SVG is refused rather than accepted and left to fail silently in the
 * recipient's client, which is where the problem would otherwise appear.
 */
export async function uploadLogo(formData: FormData): Promise<ActionResult<{ url: string }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) {
    return { ok: false, error: "Only an administrator can change the logo." };
  }

  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an image to upload." };
  }

  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) {
    return {
      ok: false,
      error:
        "SVG will not display in email - Gmail, Outlook and Apple Mail all block it. Export the logo as PNG and upload that.",
    };
  }

  const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  if (!allowed.includes(file.type)) {
    return { ok: false, error: "Use a PNG or JPEG. Those are what email clients render." };
  }

  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, error: "That file is over 2 MB. A logo should be far smaller." };
  }

  const storage = supabaseAdmin();
  const extension = file.type === "image/png" ? "png" : file.type.split("/")[1];

  // A fresh name each time: overwriting would leave the old image cached by
  // every client that has already fetched it.
  const path = `logo-${Date.now()}.${extension}`;

  const { error: uploadError } = await storage.storage
    .from(LOGO_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false, cacheControl: "31536000" });

  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}` };

  const { data } = storage.storage.from(LOGO_BUCKET).getPublicUrl(path);

  const db = await supabaseServer();
  const { error } = await db
    .from("email_settings")
    .update({ logoUrl: data.publicUrl, updatedAt: new Date().toISOString() })
    .eq("id", SETTINGS_ID);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true, data: { url: data.publicUrl } };
}

/** Renders the current template with sample data, for the Settings preview. */
export async function previewEmail(kind: "quotation" | "invoice"): Promise<string> {
  const me = await requireUser();
  const branding = await getBranding();

  const sample =
    kind === "quotation"
      ? {
          documentNumber: "QUO-2026-00042",
          contactFirstName: "Imran",
          expiryDate: "15 Sept 2026",
          dueDate: "",
        }
      : {
          documentNumber: "INV-2026-00108",
          contactFirstName: "Imran",
          expiryDate: "",
          dueDate: "30 Sept 2026",
        };

  const draft = await getDraftFor(kind, sample);

  const { html } = renderDocumentEmail({
    branding,
    documentTitle:
      kind === "quotation"
        ? `Quotation ${sample.documentNumber}`
        : `Invoice ${sample.documentNumber}`,
    message: draft.body,
    summary:
      kind === "quotation"
        ? [
            { label: "Quotation", value: sample.documentNumber },
            { label: "Date", value: "16 Aug 2026" },
            { label: "Valid until", value: sample.expiryDate },
            { label: "Total", value: "Rs 1,486,800", emphasis: true },
          ]
        : [
            { label: "Invoice", value: sample.documentNumber },
            { label: "Issued", value: "16 Aug 2026" },
            { label: "Due", value: sample.dueDate },
            { label: "Total", value: "Rs 1,486,800" },
            { label: "Outstanding", value: "Rs 1,486,800", emphasis: true },
          ],
    senderName: me.fullName,
    senderTitle: me.jobTitle,
  });

  return html;
}

/** Sends the current template to the signed-in user, so it can be seen for real. */
export async function sendTestEmail(
  kind: "quotation" | "invoice",
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) {
    return { ok: false, error: "Only an administrator can send a test." };
  }

  const resend = client();
  if (!resend) {
    return { ok: false, error: "Email is not configured. Set RESEND_API_KEY first." };
  }

  const html = await previewEmail(kind);
  const settings = await getEmailSettings();

  const { error } = await resend.emails.send({
    from: FROM,
    to: me.email,
    subject: `[Test] ${kind === "quotation" ? "Quotation" : "Invoice"} template, ${settings.companyName}`,
    html,
    text: "This is a test of the email template. Open in an HTML-capable client to see it.",
  });

  if (error) return { ok: false, error: `Could not send: ${error.message}` };

  return { ok: true, data: { id: "test" } };
}

const sendSchema = z.object({
  to: z.string().email("That does not look like an email address."),
  cc: z.string().optional().nullable(),
  subject: z.string().trim().min(1, "Give the email a subject.").max(500),
  message: z.string().trim().min(1, "Write something in the body."),
});

/**
 * Records the attempt, sends it, then records the outcome.
 *
 * The row is written first so a send that crashes mid-flight still leaves a
 * trace. relatedEntityType/Id are the polymorphic link used elsewhere, so the
 * email shows up on the record it concerns.
 */
async function deliver(input: {
  to: string;
  cc: string[];
  subject: string;
  html: string;
  text: string;
  relatedEntityType: string;
  relatedEntityId: string;
}): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  const db = await supabaseServer();
  const now = new Date().toISOString();

  const resend = client();
  if (!resend) {
    return {
      ok: false,
      error:
        "Email is not configured. Set RESEND_API_KEY (and EMAIL_FROM) before sending from here.",
    };
  }

  const rowId = randomUUID();

  const { error: writeError } = await db.from("email").insert({
    id: rowId,
    updatedAt: now,
    direction: "OUTBOUND",
    subject: input.subject,
    fromAddress: FROM,
    toAddresses: [input.to],
    ccAddresses: input.cc.length ? input.cc : null,
    bodyHtml: input.html,
    bodyText: input.text,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
    sentReceivedAt: now,
    status: "DRAFT",
    hasAttachments: false,
  });

  if (writeError) return { ok: false, error: writeError.message };

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: input.to,
    cc: input.cc.length ? input.cc : undefined,
    replyTo: REPLY_TO ?? me.email,
    subject: input.subject,
    html: input.html,
    text: input.text,
  }, { entityType: input.relatedEntityType, entityId: input.relatedEntityId });

  if (error) {
    await db
      .from("email")
      .update({ status: "FAILED", updatedAt: new Date().toISOString() })
      .eq("id", rowId);

    return { ok: false, error: `Could not send: ${error.message}` };
  }

  await db
    .from("email")
    .update({
      status: "SENT",
      messageId: data?.id ?? null,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", rowId);

  return { ok: true, data: { id: rowId } };
}

export async function sendQuotation(
  quotationId: string,
  input: z.infer<typeof sendSchema>,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.OPPORTUNITY_WRITE)) {
    return { ok: false, error: "You do not have permission to send quotations." };
  }

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the email.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();

  const { data: quote } = await db
    .from("quotation")
    .select("*, account ( name ), opportunity ( name )")
    .eq("id", quotationId)
    .is("deletedAt", null)
    .maybeSingle();

  if (!quote) return { ok: false, error: "That quotation is not available to you." };

  // A partner's quote goes to the customer only once it is approved
  // (20260928000006). Checked before the email, which cannot be taken back.
  if (quote.preparedByPartnerId && quote.approvalStatus !== "APPROVED") {
    return {
      ok: false,
      error: `${quote.quoteNumber} was prepared by a partner and has not been approved, so it cannot be sent yet.`,
    };
  }

  const branding = await getBranding();

  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: `Quotation ${quote.quoteNumber}`,
    message: d.message,
    summary: [
      { label: "Quotation", value: String(quote.quoteNumber) },
      { label: "Date", value: formatDate(quote.quoteDate) },
      { label: "Valid until", value: formatDate(quote.expiryDate) },
      { label: "Total", value: formatMoney(quote.totalAmount, quote.currencyCode), emphasis: true },
    ],
    senderName: me.fullName,
    senderTitle: me.jobTitle,
  });

  const result = await deliver({
    to: d.to,
    cc: (d.cc ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    subject: d.subject,
    html,
    text,
    relatedEntityType: "Quotation",
    relatedEntityId: quotationId,
  });

  if (!result.ok) return result;

  // Sending is what moves a draft quote into the customer's hands, so the
  // status follows — otherwise the pipeline still reads it as unsent.
  if (["DRAFT", "APPROVED", "UNDER_REVIEW"].includes(quote.status)) {
    await db
      .from("quotation")
      .update({
        status: "SENT",
        sentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .eq("id", quotationId);
  }

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath("/quotations");
  return result;
}

export async function sendInvoice(
  invoiceId: string,
  input: z.infer<typeof sendSchema>,
): Promise<ActionResult<{ id: string }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.INVOICE_WRITE)) {
    return { ok: false, error: "You do not have permission to send invoices." };
  }

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the email.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();

  const { data: invoice } = await db
    .from("invoice")
    .select("*, account ( name )")
    .eq("id", invoiceId)
    .is("deletedAt", null)
    .maybeSingle();

  if (!invoice) return { ok: false, error: "That invoice is not available to you." };

  if (invoice.status === "DRAFT") {
    return { ok: false, error: "Approve the invoice before sending it." };
  }

  const branding = await getBranding();

  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: `Invoice ${invoice.invoiceNumber}`,
    message: d.message,
    summary: [
      { label: "Invoice", value: String(invoice.invoiceNumber) },
      { label: "Issued", value: formatDate(invoice.invoiceDate) },
      { label: "Due", value: formatDate(invoice.dueDate) },
      { label: "Total", value: formatMoney(invoice.totalAmount, invoice.currencyCode) },
      {
        label: "Outstanding",
        value: formatMoney(invoice.outstandingAmount, invoice.currencyCode),
        emphasis: true,
      },
    ],
    senderName: me.fullName,
    senderTitle: me.jobTitle,
  });

  const result = await deliver({
    to: d.to,
    cc: (d.cc ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    subject: d.subject,
    html,
    text,
    relatedEntityType: "Invoice",
    relatedEntityId: invoiceId,
  });

  if (!result.ok) return result;

  if (invoice.status === "APPROVED") {
    await db
      .from("invoice")
      .update({
        status: "SENT",
        sentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .eq("id", invoiceId);
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return result;
}

/** Emails already sent about one record, newest first. */
export async function listEmails(entityType: string, entityId: string) {
  await requireUser();
  const db = await supabaseServer();

  const { data, error } = await db
    .from("email")
    .select("id, subject, toAddresses, status, sentReceivedAt, direction")
    .eq("relatedEntityType", entityType)
    .eq("relatedEntityId", entityId)
    .order("sentReceivedAt", { ascending: false })
    .limit(50);

  if (error) throw new Error(`Could not load emails: ${error.message}`);
  return data ?? [];
}
