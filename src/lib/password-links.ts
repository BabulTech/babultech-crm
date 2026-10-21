import { createHash, randomBytes, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { Resend } from "resend";
import { z } from "zod";
import { supabaseAdmin } from "./supabase";
import { writeAudit } from "./audit";
import { isReservedAddress } from "./notification-mailer";
import { renderSystemEmail } from "./system-emails";
import { renderDocumentEmail, brandingFromSettings, emailSettingsFromRow, EMAIL_SETTINGS_ID } from "./email-template";

/**
 * Single-use links that let someone set their own password.
 *
 * WELCOME goes out when a login is created, so a new person no longer waits
 * on whoever made the account to pass a temporary password on. RESET is sent
 * by an administrator from the user's page. Either way the person chooses the
 * password themselves and nobody else ever sees it.
 *
 * Only the token's SHA-256 is stored (password_link). A link works once,
 * until it expires, and issuing a new one for the same login retires the old.
 * Not a server-action module: the actions that call this check permissions
 * first, in src/server/password-links.ts and src/server/users.ts.
 */

export type PasswordLinkPurpose = "WELCOME" | "RESET";

export const PASSWORD_LINK_HOURS: Record<PasswordLinkPurpose, number> = { WELCOME: 7 * 24, RESET: 24 };

export const passwordRules = z
  .string()
  .min(10, "Use at least 10 characters.")
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), "Mix upper and lower case.")
  .refine((v) => /[0-9]/.test(v), "Include a number.");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Where the link points. The site the administrator is using comes first, so
 * the link follows the app if it moves host; the saved public address is the
 * fallback when there is no request to go on.
 */
async function appUrl(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  } catch {
    /* Outside a request. */
  }
  const { data } = await supabaseAdmin().from("company_setting").select("publicAppUrl").maybeSingle();
  const configured = (data?.publicAppUrl as string | null) || process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || "http://localhost:3000";
  return configured.replace(/\/$/, "");
}

export interface IssuedLink {
  url: string;
  expiresAt: string;
  /** The address it was emailed to, or null when it was not sent. */
  emailedTo: string | null;
  /** Why it was not emailed, when it was not. */
  emailError: string | null;
}

/** Creates a link for one login and emails it to their sign-in address. */
export async function issuePasswordLink(input: {
  userId: string;
  purpose: PasswordLinkPurpose;
  createdBy: { id: string; fullName: string; jobTitle?: string | null };
}): Promise<IssuedLink> {
  const db = supabaseAdmin();
  const { data: user, error } = await db.from("app_user").select("id, fullName, email").eq("id", input.userId).is("deletedAt", null).maybeSingle();
  if (error || !user) throw new Error("That login no longer exists.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PASSWORD_LINK_HOURS[input.purpose] * 3_600_000).toISOString();
  const stamp = new Date().toISOString();

  // A newer link replaces any that are still open.
  await db.from("password_link").update({ usedAt: stamp }).eq("userId", user.id).is("usedAt", null);
  const { error: insertError } = await db.from("password_link").insert({
    userId: user.id, purpose: input.purpose, tokenHash: hashToken(token), expiresAt, createdById: input.createdBy.id,
  });
  if (insertError) throw new Error(`Could not create the link: ${insertError.message}`);

  await writeAudit({
    entityType: "User", entityId: user.id, fieldName: "passwordLink", oldValue: null,
    newValue: input.purpose === "WELCOME" ? "welcome link sent" : "reset link sent", changedById: input.createdBy.id,
  }, db);

  const url = `${await appUrl()}/reset-password/${token}`;
  const result: IssuedLink = { url, expiresAt, emailedTo: null, emailError: null };

  const to = String(user.email);
  if (isReservedAddress(to)) return { ...result, emailError: "Test address, not sent." };
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ...result, emailError: "Email is not set up on this server (RESEND_API_KEY)." };

  const { data: settings } = await db.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const firstName = String(user.fullName).split(" ")[0] || String(user.fullName);
  const welcome = input.purpose === "WELCOME";
  const days = PASSWORD_LINK_HOURS[input.purpose] / 24;
  const lasts = days >= 2 ? `${days} days` : "24 hours";
  const signIn = `${url.slice(0, url.indexOf("/reset-password/"))}/login`;

  // Wording from Settings → System emails, or the built-in default.
  const template = await renderSystemEmail(welcome ? "LOGIN_WELCOME" : "PASSWORD_RESET", {
    firstName, fullName: String(user.fullName), email: to, companyName: branding.companyName, linkLasts: lasts,
  });
  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: welcome ? `Your ${branding.companyName} CRM login` : "Reset your password",
    message: "",
    messageHtml: template.messageHtml,
    summary: [
      { label: "Your sign-in email", value: to, emphasis: true },
      { label: "Sign in at", value: signIn },
    ],
    action: { label: welcome ? "Choose my password" : "Set a new password", url },
    senderName: input.createdBy.fullName,
    senderTitle: input.createdBy.jobTitle ?? null,
  });

  const from = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
  const subject = template.subject;
  const rowId = randomUUID();
  // The link itself is not kept in the email log: it is as good as a password until used.
  const safeHtml = html.split(url).join(`${url.slice(0, url.lastIndexOf("/"))}/…`);
  const safeText = text.split(url).join(`${url.slice(0, url.lastIndexOf("/"))}/…`);
  await db.from("email").insert({
    id: rowId, updatedAt: stamp, direction: "OUTBOUND", subject, fromAddress: from, toAddresses: [to],
    bodyHtml: safeHtml, bodyText: safeText, relatedEntityType: "User", relatedEntityId: user.id,
    sentReceivedAt: stamp, status: "DRAFT", hasAttachments: false,
  });

  const sent = await new Resend(key).emails.send({ from, to: [to], subject, html, text, replyTo: process.env.EMAIL_REPLY_TO });
  await db.from("email").update(sent.error
    ? { status: "FAILED", updatedAt: new Date().toISOString() }
    : { status: "SENT", messageId: sent.data?.id ?? null, updatedAt: new Date().toISOString() }).eq("id", rowId);

  return sent.error ? { ...result, emailError: sent.error.message } : { ...result, emailedTo: to };
}

/** Who an open link belongs to, or null for an unknown, used or expired one. */
export async function readPasswordLink(token: string) {
  if (!token || token.length > 200) return null;
  const db = supabaseAdmin();
  const { data } = await db.from("password_link").select("id, userId, purpose, expiresAt, usedAt").eq("tokenHash", hashToken(token)).maybeSingle();
  if (!data || data.usedAt || Date.parse(String(data.expiresAt)) < Date.now()) return null;
  const { data: user } = await db.from("app_user").select("id, fullName, email, status, deletedAt").eq("id", data.userId).maybeSingle();
  if (!user || user.deletedAt || user.status === "SUSPENDED") return null;
  return {
    linkId: String(data.id),
    purpose: data.purpose as PasswordLinkPurpose,
    userId: String(user.id),
    fullName: String(user.fullName),
    email: String(user.email),
    active: user.status === "ACTIVE",
  };
}

/** Sets the password through a link, and uses the link up. */
export async function redeemPasswordLink(token: string, password: string): Promise<{ ok: true; email: string; active: boolean } | { ok: false; error: string }> {
  const parsed = passwordRules.safeParse(password);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That password is too weak." };

  const link = await readPasswordLink(token);
  if (!link) return { ok: false, error: "This link is no longer valid. Ask your administrator for a new one." };

  // Claimed before the password changes, so the same link cannot be used twice at once.
  const db = supabaseAdmin();
  const { data: claimed } = await db.from("password_link").update({ usedAt: new Date().toISOString() })
    .eq("id", link.linkId).is("usedAt", null).select("id");
  if (!claimed?.length) return { ok: false, error: "This link has just been used. Ask your administrator for a new one." };

  // Supabase Auth holds the credential that sign-in checks.
  const { error } = await db.auth.admin.updateUserById(link.userId, { password: parsed.data });
  if (error) {
    await db.from("password_link").update({ usedAt: null }).eq("id", link.linkId);
    return { ok: false, error: `Could not set the password: ${error.message}` };
  }
  await db.from("app_user").update({ updatedAt: new Date().toISOString() }).eq("id", link.userId);
  await writeAudit({ entityType: "User", entityId: link.userId, fieldName: "passwordHash", oldValue: null, newValue: "set by link", changedById: link.userId }, db);
  return { ok: true, email: link.email, active: link.active };
}
