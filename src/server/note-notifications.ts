"use server";

import { randomUUID } from "node:crypto";
import { Resend } from "@/lib/mail";
import { supabaseAdmin } from "@/lib/supabase";
import { renderDocumentEmail, type EmailBranding } from "@/lib/email-template";
import { mentionsToPlain } from "@/lib/mentions";

/**
 * Telling someone they were named in a note.
 *
 * Deliberately best-effort, for the same reason as the expense notifications:
 * the note is the real work and it is already written. A mail server being
 * unreachable must never lose it. Failures are returned rather than thrown, and
 * the caller records which recipients actually got through so an unsent mention
 * stays visibly unsent rather than silently pretending.
 *
 * The service-role client is used throughout. The recipient may sit outside the
 * author's data scope — mentioning a colleague in another department is the
 * normal case, not an edge one.
 */

const FROM = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key, "Note mention") : null;
}

/**
 * Per-user delivery overrides. Read separately rather than joined, because
 * naming a column PostgREST does not know fails the whole query — so a database
 * without the notificationEmail migration would lose notifications entirely
 * rather than just the override.
 */
async function notificationOverrides(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<Map<string, string>> {
  const { data, error } = await db.from("app_user").select("id, notificationEmail");
  if (error) return new Map();

  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const value = (row as { notificationEmail?: string | null }).notificationEmail;
    if (value?.trim()) map.set(row.id, value.trim());
  }
  return map;
}

async function branding(): Promise<EmailBranding> {
  const db = supabaseAdmin();
  const { data } = await db.from("email_settings").select("*").eq("id", SETTINGS_ID).maybeSingle();

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

/**
 * Where a note's record actually lives, so the email can link to it.
 *
 * Entity types that have no detail page of their own fall back to the
 * dashboard: a link that goes somewhere sensible beats a 404, and beats
 * omitting the link entirely.
 */
const ENTITY_PATHS: Record<string, string> = {
  Account: "accounts",
  Contact: "contacts",
  Lead: "leads",
  Opportunity: "opportunities",
  Quotation: "quotations",
  Contract: "contracts",
  SupportCase: "cases",
  Project: "projects",
  Invoice: "invoices",
  Partner: "partners",
  Campaign: "campaigns",
  Product: "products",
  Expense: "expenses",
  VendorBill: "vendor-bills",
  Payment: "payments",
};

function recordUrl(entityType: string, entityId: string): string {
  const segment = ENTITY_PATHS[entityType];
  return segment ? `${APP_URL}/${segment}/${entityId}` : APP_URL;
}

/**
 * Tell each mentioned person, and return the ids that were actually sent.
 *
 * The returned list is what the caller stamps `notifiedAt` on, so a recipient
 * whose send failed keeps a null and can be retried.
 */
export async function notifyMentioned(input: {
  noteId: string;
  content: string;
  authorId: string;
  recipientIds: string[];
  entityType: string;
  entityId: string;
}): Promise<string[]> {
  if (!input.recipientIds.length) return [];

  const db = supabaseAdmin();

  const { data: people } = await db
    .from("app_user")
    .select("id, fullName, email")
    .in("id", [...input.recipientIds, input.authorId]);

  const author = (people ?? []).find((p) => String(p.id) === input.authorId);
  const recipients = (people ?? []).filter((p) => input.recipientIds.includes(String(p.id)));
  if (!recipients.length) return [];

  const overrides = await notificationOverrides(db);
  const mail = client();

  // Without an API key the mention still stands; nobody is told, and
  // notifiedAt stays null so it is visible that they were not.
  if (!mail) return [];

  const brand = await branding();
  const url = recordUrl(input.entityType, input.entityId);

  // The tokens are replaced with readable names: an email showing
  // "@[Hassan Shamsi](user:37f2…)" would look broken.
  const readable = mentionsToPlain(input.content);
  const excerpt = readable.length > 500 ? `${readable.slice(0, 500)}…` : readable;

  const sent: string[] = [];

  for (const person of recipients) {
    const to = overrides.get(String(person.id)) || person.email;
    if (!to) continue;

    const { html, text } = renderDocumentEmail({
      branding: brand,
      documentTitle: `${author?.fullName ?? "Someone"} mentioned you in a note`,
      message: excerpt,
      summary: [
        { label: "Mentioned by", value: author?.fullName ?? "Someone" },
        { label: "On", value: `${input.entityType.replace(/([A-Z])/g, " $1").trim()}` },
      ],
      action: { label: "Open the record", url },
      senderName: author?.fullName ?? "BabulTech CRM",
    });

    try {
      const { error } = await mail.emails.send({
        from: FROM,
        to,
        subject: `${author?.fullName ?? "Someone"} mentioned you in a note`,
        html,
        text,
      });

      // The email row is the record of what was attempted, successful or not —
      // a trail showing only successes would misrepresent what happened.
      await db.from("email").insert({
        id: randomUUID(),
        direction: "OUTBOUND",
        subject: `Mention in a note`,
        body: text,
        fromAddress: FROM,
        toAddresses: [to],
        status: error ? "FAILED" : "SENT",
        sentAt: new Date().toISOString(),
        relatedEntityType: input.entityType,
        relatedEntityId: input.entityId,
        updatedAt: new Date().toISOString(),
      });

      if (!error) sent.push(String(person.id));
    } catch {
      // One failed recipient must not stop the others being told.
    }
  }

  return sent;
}
