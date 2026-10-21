import { sanitizeRichText, richTextToPlain } from "./rich-text";

/**
 * The HTML wrapper every outbound email gets.
 *
 * Email rendering is twenty years behind the web and the constraints are real:
 *
 *   - Outlook uses Word to render HTML. No flexbox, no grid, no float. Tables.
 *   - Gmail strips <style> blocks, so every rule is an inline attribute.
 *   - SVG is blocked everywhere. Logos must be PNG or JPEG.
 *   - Background images are unreliable; background colours are fine.
 *   - Images are often blocked by default, so nothing may depend on one
 *     loading — hence the text wordmark shown when no logo URL is set.
 *
 * The palette comes from email_settings rather than being fixed here, so the
 * brand can change without a deploy. The layout is light-background even where
 * the brand is dark: a dark email is legible on a phone and mangled in
 * Outlook, and this has to arrive readable more than it has to look striking.
 */

export interface EmailBranding {
  companyName: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  addressLine: string | null;
  brandColor: string;
  brandColorDark: string;
  textColor: string;
  mutedColor: string;
  backgroundColor: string;
  emailFooter: string;
}

/** The one email settings row. */
export const EMAIL_SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

/**
 * The email settings row, with a fallback for every field. A send must not
 * fail because the settings row was deleted, so nothing here is required.
 */
export function emailSettingsFromRow(data: Record<string, unknown> | null | undefined) {
  const text = (key: string) => (data?.[key] as string | null | undefined) ?? null;
  return {
    companyName: text("companyName") ?? "BabulTech",
    logoUrl: text("logoUrl"),
    websiteUrl: text("websiteUrl"),
    supportEmail: text("supportEmail"),
    supportPhone: text("supportPhone"),
    addressLine: text("addressLine"),
    brandColor: text("brandColor") ?? "#00B8A4",
    brandColorDark: text("brandColorDark") ?? "#0F172A",
    textColor: text("textColor") ?? "#1A2233",
    mutedColor: text("mutedColor") ?? "#64748B",
    backgroundColor: text("backgroundColor") ?? "#F1F5F9",
    emailFooter:
      text("emailFooter") ??
      "This email and any attachments are confidential and intended solely for the addressee.",
    quotationSubject: text("quotationSubject") ?? "Quotation {{documentNumber}} from {{companyName}}",
    quotationBody: text("quotationBody") ?? "Dear {{contactFirstName}},\n\nPlease find our quotation below.",
    invoiceSubject: text("invoiceSubject") ?? "Invoice {{documentNumber}} from {{companyName}}",
    invoiceBody: text("invoiceBody") ?? "Dear {{contactFirstName}},\n\nPlease find our invoice below.",
  };
}

export type EmailSettings = ReturnType<typeof emailSettingsFromRow>;

/** The branding part of the settings - what every document email is wrapped in. */
export function brandingFromSettings(s: EmailSettings): EmailBranding {
  return {
    companyName: s.companyName,
    logoUrl: s.logoUrl,
    websiteUrl: s.websiteUrl,
    supportEmail: s.supportEmail,
    supportPhone: s.supportPhone,
    addressLine: s.addressLine,
    brandColor: s.brandColor,
    brandColorDark: s.brandColorDark,
    textColor: s.textColor,
    mutedColor: s.mutedColor,
    backgroundColor: s.backgroundColor,
    emailFooter: s.emailFooter,
  };
}

export interface SummaryRow {
  label: string;
  value: string;
  /** Rendered larger and in the brand colour — one per email at most. */
  emphasis?: boolean;
}

export interface DocumentEmail {
  branding: EmailBranding;
  /** "Quotation QUO-2026-00001" — the line under the logo. */
  documentTitle: string;
  /** The typed message, plain text with blank lines between paragraphs. */
  message: string;
  /**
   * The message as rich text, from an editable template. Used instead of
   * `message` when given; cleaned again here before it is sent.
   */
  messageHtml?: string | null;
  summary: SummaryRow[];
  /** Optional call to action, e.g. a link back to a portal. */
  action?: { label: string; url: string };
  senderName: string;
  /** The sender's designation, signed as "Hasan Shamsi (CEO)". */
  senderTitle?: string | null;
}

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A URL safe to put in href/src. Anything not http(s) is dropped. */
const safeUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * A rich-text message styled for email clients, which ignore stylesheets:
 * every paragraph, list and link carries its own inline style.
 */
function richParagraphs(html: string, color: string, linkColor: string): string {
  const clean = sanitizeRichText(html) ?? "";
  return clean
    .replace(/<p>/g, `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${color};">`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.65;color:${color};">`)
    .replace(/<h([1-3])>/g, `<h$1 style="margin:0 0 12px;font-size:17px;color:${color};">`)
    .replace(/<a /g, `<a style="color:${linkColor};" `);
}

function paragraphs(text: string, color: string): string {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${color};">${escape(
          p.trim(),
        ).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

/**
 * The masthead.
 *
 * The logo, when one is configured and reachable over http(s), is a small
 * square icon beside the company name; otherwise the name alone, in the brand
 * colour. The fallback is not a degradation — many
 * recipients block images by default, so the text version is what a large
 * share of readers see either way.
 */
function masthead(b: EmailBranding): string {
  const logo = safeUrl(b.logoUrl);
  const site = safeUrl(b.websiteUrl);

  const name = `<span style="display:inline-block;font-size:20px;font-weight:700;letter-spacing:-0.3px;color:${b.brandColorDark};">${escape(
    b.companyName,
  )}</span>`;
  const inner = logo
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;"><img src="${escape(logo)}" alt="" width="36" height="36" style="display:block;border:0;width:36px;height:36px;border-radius:8px;"></td>
        <td style="vertical-align:middle;padding-left:10px;">${name}</td>
      </tr></table>`
    : name;

  return site
    ? `<a href="${escape(site)}" style="text-decoration:none;">${inner}</a>`
    : inner;
}

export function renderDocumentEmail(input: DocumentEmail): { html: string; text: string } {
  const { branding: b, documentTitle, summary, action, senderName, senderTitle, messageHtml } = input;
  // A rich-text template supplies the plain version too, for the text part
  // and the inbox preview line.
  const message = messageHtml ? richTextToPlain(messageHtml) : input.message;
  const signedBy = senderTitle?.trim() ? `${senderName} (${senderTitle.trim()})` : senderName;

  const summaryRows = summary
    .map(
      (row) => `
        <tr>
          <td style="padding:9px 0;font-size:14px;color:${b.mutedColor};border-bottom:1px solid #E8ECF2;">${escape(row.label)}</td>
          <td style="padding:9px 0;font-size:${row.emphasis ? "18px" : "14px"};font-weight:${row.emphasis ? "700" : "600"};color:${row.emphasis ? b.brandColorDark : b.textColor};text-align:right;border-bottom:1px solid #E8ECF2;">${escape(row.value)}</td>
        </tr>`,
    )
    .join("");

  const actionUrl = action ? safeUrl(action.url) : null;

  const actionBlock =
    action && actionUrl
      ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
        <tr><td style="border-radius:6px;background:${b.brandColor};">
          <a href="${escape(actionUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#052E2B;text-decoration:none;">${escape(action.label)}</a>
        </td></tr>
      </table>`
      : "";

  const contactLine = [
    b.supportEmail ? `<a href="mailto:${escape(b.supportEmail)}" style="color:${b.mutedColor};text-decoration:none;">${escape(b.supportEmail)}</a>` : null,
    b.supportPhone ? escape(b.supportPhone) : null,
    safeUrl(b.websiteUrl)
      ? `<a href="${escape(safeUrl(b.websiteUrl)!)}" style="color:${b.mutedColor};text-decoration:none;">${escape(
          b.websiteUrl!.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        )}</a>`
      : null,
  ]
    .filter(Boolean)
    .join(" &nbsp;·&nbsp; ");

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escape(documentTitle)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${b.backgroundColor};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(documentTitle)}, ${escape(
    message.split("\n")[0].slice(0, 90),
  )}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${b.backgroundColor};">
<tr><td align="center" style="padding:32px 16px;">

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">

    <tr><td style="height:4px;background-color:${b.brandColor};font-size:0;line-height:0;">&nbsp;</td></tr>

    <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #E8ECF2;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td align="left" style="vertical-align:middle;">${masthead(b)}</td>
          <td align="right" style="vertical-align:middle;font-size:13px;font-weight:600;color:${b.mutedColor};">${escape(documentTitle)}</td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:28px 32px 8px;">
      ${messageHtml ? richParagraphs(messageHtml, b.textColor, b.brandColorDark) : paragraphs(message, b.textColor)}
    </td></tr>

    ${
      summary.length
        ? `<tr><td style="padding:4px 32px 8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#F8FAFC;border-radius:8px;">
        <tr><td style="padding:6px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${summaryRows}</table>
        </td></tr>
      </table>
      ${actionBlock}
    </td></tr>`
        : ""
    }

    <tr><td style="padding:22px 32px 28px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:${b.textColor};">Kind regards,<br><strong>${escape(signedBy)}</strong></p>
      <p style="margin:4px 0 0;font-size:13px;color:${b.mutedColor};">${escape(b.companyName)}</p>
    </td></tr>

    <tr><td style="padding:20px 32px;background-color:#F8FAFC;border-top:1px solid #E8ECF2;">
      ${contactLine ? `<p style="margin:0 0 8px;font-size:12px;color:${b.mutedColor};">${contactLine}</p>` : ""}
      ${b.addressLine ? `<p style="margin:0 0 8px;font-size:12px;color:${b.mutedColor};">${escape(b.addressLine)}</p>` : ""}
      <p style="margin:0;font-size:11px;line-height:1.5;color:${b.mutedColor};">${escape(b.emailFooter)}</p>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;

  // The plain-text part is not a fallback nobody reads: some clients prefer it,
  // spam filters weigh its absence, and screen readers often use it.
  const text = [
    documentTitle,
    "",
    message,
    "",
    ...summary.map((r) => `${r.label}: ${r.value}`),
    action && actionUrl ? `\n${action.label}: ${actionUrl}` : "",
    "",
    `Kind regards,`,
    signedBy,
    b.companyName,
    "",
    [b.supportEmail, b.supportPhone, b.websiteUrl].filter(Boolean).join(" · "),
    b.addressLine ?? "",
    "",
    b.emailFooter,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return { html, text };
}

/**
 * Fills {{placeholders}} in a stored template.
 *
 * Unknown placeholders are left as they are rather than blanked: a visible
 * {{customerName}} in a draft is a mistake someone will catch, an empty gap is
 * one they will not.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}
