import { supabaseAdmin } from "./supabase";

/**
 * The emails the CRM sends on its own: logins, password links, contracts to
 * sign, portal access. Administrators can rewrite the subject and message of
 * each (Settings → System emails); the wording here is the default used
 * until they do, and again after "Reset to default".
 *
 * Only the subject and message are editable. The button, the details box, the
 * logo and the footer are added by the layout, so an edit can never lose the
 * link the email exists to deliver.
 *
 * Placeholders are written {likeThis}. Values are escaped before they go in.
 */

export interface SystemEmail {
  key: SystemEmailKey;
  name: string;
  /** When it is sent, for the settings screen. */
  sentWhen: string;
  placeholders: { name: string; meaning: string; sample: string }[];
  subject: string;
  /** Rich text (HTML), as the editor saves it. */
  body: string;
}

export type SystemEmailKey =
  | "LOGIN_WELCOME"
  | "PASSWORD_RESET"
  | "CONTRACT_SIGNING"
  | "CUSTOMER_PORTAL_WELCOME"
  | "PARTNER_PORTAL_WELCOME"
  | "PORTAL_PASSWORD_RESET";

const P = {
  firstName: { name: "firstName", meaning: "Their first name", sample: "Samiullah" },
  fullName: { name: "fullName", meaning: "Their full name", sample: "Samiullah Khan" },
  email: { name: "email", meaning: "The address they sign in with", sample: "samiullah@example.com" },
  companyName: { name: "companyName", meaning: "Your company name, from Settings", sample: "BabulTech" },
  linkLasts: { name: "linkLasts", meaning: "How long the link works", sample: "7 days" },
};

export const SYSTEM_EMAILS: SystemEmail[] = [
  {
    key: "LOGIN_WELCOME",
    name: "New login: choose your password",
    sentWhen: "When a login is created, from Users or from HR.",
    placeholders: [P.firstName, P.fullName, P.email, P.companyName, P.linkLasts],
    subject: "Your {companyName} CRM login",
    body:
      "<p>Hello {firstName},</p>" +
      "<p>A login has been created for you on the {companyName} CRM. Choose your password using the button below, then sign in with your email address.</p>" +
      "<p>The link works once and lasts {linkLasts}. If it runs out, ask your administrator to send a new one.</p>",
  },
  {
    key: "PASSWORD_RESET",
    name: "Password reset link",
    sentWhen: "When an administrator clicks Send password reset link on a user's page.",
    placeholders: [P.firstName, P.fullName, P.email, P.companyName, P.linkLasts],
    subject: "Reset your {companyName} CRM password",
    body:
      "<p>Hello {firstName},</p>" +
      "<p>Your administrator has sent you a link to set a new password for the {companyName} CRM. Use the button below to choose it, then sign in with your email address.</p>" +
      "<p>The link works once and lasts {linkLasts}. If you were not expecting this, tell your administrator.</p>",
  },
  {
    key: "CONTRACT_SIGNING",
    name: "Contract ready to sign",
    sentWhen: "When a contract is sent for signing by email, from HR.",
    placeholders: [
      P.fullName, P.firstName, P.companyName,
      { name: "contractNumber", meaning: "The contract's number", sample: "EC-2026-0007" },
      { name: "contractType", meaning: "Internship, Permanent, Co-founder…", sample: "permanent" },
      { name: "position", meaning: "Their job title on the contract", sample: "Software Engineer" },
      { name: "linkDays", meaning: "How many days the signing link works", sample: "14" },
    ],
    subject: "Your contract {contractNumber} is ready to sign",
    body:
      "<p>Dear {fullName},</p>" +
      "<p>Your {contractType} contract is ready. Please read it and sign it using the link below. The link works for {linkDays} days.</p>",
  },
  {
    key: "CUSTOMER_PORTAL_WELCOME",
    name: "Support portal access",
    sentWhen: "When a customer contact is given a login to the support portal.",
    placeholders: [P.firstName, P.fullName, P.email, P.companyName],
    subject: "Your {companyName} support portal access",
    body:
      "<p>Hello {firstName},</p>" +
      "<p>You can now sign in to raise support tickets with us, follow what is happening with them, and read our help articles.</p>" +
      "<p>Use the details below to sign in. Please change the password after you first sign in, and do not share it.</p>",
  },
  {
    key: "PARTNER_PORTAL_WELCOME",
    name: "Partner portal access",
    sentWhen: "When a partner is given a login to the partner portal.",
    placeholders: [P.firstName, P.fullName, P.email, P.companyName],
    subject: "Your {companyName} partner portal access",
    body:
      "<p>Hello {firstName},</p>" +
      "<p>You can now sign in to our partner portal to add customers and deals, follow the ones you have brought us, and see your commission on each.</p>" +
      "<p>Use the details below to sign in. Please change the password after you first sign in, and do not share it.</p>",
  },
  {
    key: "PORTAL_PASSWORD_RESET",
    name: "Portal password reset",
    sentWhen: "When a customer's or partner's portal password is reset.",
    placeholders: [
      P.firstName, P.fullName, P.email, P.companyName,
      { name: "portalName", meaning: "support portal or partner portal", sample: "support portal" },
    ],
    subject: "Your new {companyName} portal password",
    body:
      "<p>Hello {firstName},</p>" +
      "<p>Your {portalName} password has been reset. Use the details below to sign in.</p>" +
      "<p>If you did not ask for this, tell us straight away.</p>",
  },
];

export function systemEmailDefault(key: SystemEmailKey): SystemEmail {
  const found = SYSTEM_EMAILS.find((e) => e.key === key);
  if (!found) throw new Error(`Unknown system email ${key}`);
  return found;
}

const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Puts values into {placeholders}. Unknown ones are left as written. */
export function fillPlaceholders(template: string, values: Record<string, string>, html: boolean): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    name in values ? (html ? escapeHtml(values[name]) : values[name]) : whole,
  );
}

/** The subject and message to send: the administrator's version, else the default. */
export async function renderSystemEmail(key: SystemEmailKey, values: Record<string, string>): Promise<{ subject: string; messageHtml: string }> {
  const fallback = systemEmailDefault(key);
  let subject = fallback.subject;
  let body = fallback.body;
  try {
    const { data } = await supabaseAdmin().from("system_email_template").select("subject, body").eq("key", key).maybeSingle();
    if (data?.subject && data?.body) { subject = String(data.subject); body = String(data.body); }
  } catch {
    /* The built-in wording still sends. */
  }
  return { subject: fillPlaceholders(subject, values, false), messageHtml: fillPlaceholders(body, values, true) };
}

/** The sample values for previews and test sends. */
export function sampleValues(key: SystemEmailKey, companyName: string): Record<string, string> {
  return Object.fromEntries(systemEmailDefault(key).placeholders.map((p) => [p.name, p.name === "companyName" ? companyName : p.sample]));
}
