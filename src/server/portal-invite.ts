"use server";

import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";
import { renderDocumentEmail, type EmailBranding } from "@/lib/email-template";
import { renderSystemEmail } from "@/lib/system-emails";
import { isReservedAddress } from "@/lib/notification-mailer";

/**
 * The email that tells a customer they can sign in.
 *
 * Best-effort, like every other notification here: a failed email must never
 * undo the access it is announcing. The outcome comes back to the caller, which
 * says on screen whether it was sent or whether the password has to be passed
 * on by hand.
 *
 * The password is in the body because there is nowhere else for it to be: this
 * system has no "set your own password" link, and an account nobody can get
 * into is worse than a password in an inbox. Worth replacing with a one-time
 * link when that page exists.
 */

const FROM = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

async function branding(): Promise<EmailBranding> {
  const { data } = await supabaseAdmin()
    .from("email_settings")
    .select("*")
    .eq("id", SETTINGS_ID)
    .maybeSingle();

  return {
    companyName: data?.companyName ?? "BabulTech",
    logoUrl: data?.logoUrl ?? null,
    websiteUrl: data?.websiteUrl ?? null,
    supportEmail: data?.supportEmail ?? null,
    supportPhone: data?.supportPhone ?? null,
    addressLine: data?.addressLine ?? null,
    brandColor: data?.brandColor ?? "#00B8A4",
    brandColorDark: data?.brandColorDark ?? "#0F172A",
    textColor: data?.textColor ?? "#1A2233",
    mutedColor: data?.mutedColor ?? "#64748B",
    backgroundColor: data?.backgroundColor ?? "#F1F5F9",
    emailFooter:
      data?.emailFooter ??
      "This email and any attachments are confidential and intended solely for the addressee.",
  };
}

export async function sendPortalWelcome(input: {
  to: string;
  fullName: string;
  password: string;
  contactId: string;
  /** A first invitation, or a replacement password for an existing login. */
  kind: "welcome" | "reset";
  /** Which portal they are being let into, which is all that differs. */
  audience?: "customer" | "partner";
}): Promise<{ ok: boolean; error?: string }> {
  // Test addresses are never mailed, so a test run cannot email anyone.
  if (isReservedAddress(input.to)) return { ok: false, error: "Test address, not sent" };
  const b = await branding();
  const first = input.kind === "welcome";
  const signInUrl = `${APP_URL.replace(/\/$/, "")}/login`;

  const partner = input.audience === "partner";
  const portalName = partner ? "partner portal" : "support portal";
  const firstName = input.fullName.split(" ")[0] ?? input.fullName;

  // Wording from Settings → System emails, or the built-in default.
  const template = await renderSystemEmail(
    first ? (partner ? "PARTNER_PORTAL_WELCOME" : "CUSTOMER_PORTAL_WELCOME") : "PORTAL_PASSWORD_RESET",
    { firstName, fullName: input.fullName, email: input.to, companyName: b.companyName, portalName },
  );

  const { html, text } = renderDocumentEmail({
    branding: b,
    documentTitle: first ? `Your ${portalName} access` : "Your new portal password",
    message: "",
    messageHtml: template.messageHtml,
    summary: [
      { label: "Sign in at", value: signInUrl },
      { label: "Your email", value: input.to },
      { label: "Temporary password", value: input.password, emphasis: true },
    ],
    action: { label: "Sign in", url: signInUrl },
    senderName: b.companyName,
  });

  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const rowId = randomUUID();
  const base = {
    id: rowId,
    updatedAt: now,
    direction: "OUTBOUND",
    subject: template.subject,
    fromAddress: FROM,
    toAddresses: [input.to],
    bodyHtml: html,
    bodyText: text,
    relatedEntityType: "Contact",
    relatedEntityId: input.contactId,
    sentReceivedAt: now,
    hasAttachments: false,
  };

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Recorded rather than sent, so the trail shows what would have gone out.
    await db.from("email").insert({ ...base, status: "FAILED" });
    return { ok: false, error: "Email is not configured (RESEND_API_KEY is not set)." };
  }

  await db.from("email").insert({ ...base, status: "DRAFT" });

  const { data, error } = await new Resend(key).emails.send({
    from: FROM,
    to: [input.to],
    subject: base.subject,
    html,
    text,
  });

  await db
    .from("email")
    .update(
      error
        ? { status: "FAILED", updatedAt: new Date().toISOString() }
        : { status: "SENT", messageId: data?.id ?? null, updatedAt: new Date().toISOString() },
    )
    .eq("id", rowId);

  return error ? { ok: false, error: error.message } : { ok: true };
}
