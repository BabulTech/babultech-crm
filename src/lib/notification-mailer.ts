import { Resend } from "@/lib/mail";
import { supabaseAdmin } from "./supabase";
import { renderDocumentEmail, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID } from "./email-template";

/**
 * Emails the notifications people asked to get by email.
 *
 * One email per person per visit of the runner, not one per notification: a
 * bulk reassignment of forty leads is one email listing them, not forty.
 * Anything that cannot be sent is marked, never retried for ever - the bell
 * still has it.
 */

const FROM = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * The domains set aside for examples and testing (RFC 2606). Nobody reads mail
 * there, and the test accounts use them, so a test run never sends email.
 */
export function isReservedAddress(address: string): boolean {
  const domain = address.split("@")[1]?.toLowerCase().trim() ?? "";
  return /(^|\.)example\.(com|org|net)$/.test(domain) || /\.(test|invalid|example|localhost)$/.test(domain);
}

interface PendingRow {
  id: string;
  userId: string;
  title: string;
  body: string | null;
  link: string | null;
}

export async function sendPendingNotificationEmails(deadline: number): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("notification")
    .select("id, userId, title, body, link")
    .eq("emailStatus", "PENDING")
    .order("createdAt")
    .limit(500);
  if (error || !data?.length) return 0;
  const rows = data as PendingRow[];

  const mark = async (ids: string[], status: "SENT" | "FAILED" | "SKIPPED", message?: string) => {
    const at = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 200) {
      await db
        .from("notification")
        .update({ emailStatus: status, emailedAt: at, emailError: message?.slice(0, 500) ?? null })
        .in("id", ids.slice(i, i + 200));
    }
  };

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    await mark(rows.map((r) => r.id), "SKIPPED", "No mail provider is configured.");
    return rows.length;
  }

  const byUser = new Map<string, PendingRow[]>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

  const { data: people } = await db
    .from("app_user")
    .select("id, fullName, email, notificationEmail, status, deletedAt")
    .in("id", [...byUser.keys()]);
  const personById = new Map((people ?? []).map((p) => [p.id as string, p]));

  const { data: settings } = await db.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const mail = new Resend(key, "Notification");
  let handled = 0;

  for (const [userId, items] of byUser) {
    if (Date.now() >= deadline - 3_000) break;
    const ids = items.map((i) => i.id);
    const person = personById.get(userId);
    const to = ((person?.notificationEmail as string | null)?.trim() || (person?.email as string | null)) ?? null;
    if (!person || person.status !== "ACTIVE" || person.deletedAt || !to || isReservedAddress(to)) {
      await mark(ids, "SKIPPED", "No active address to send to.");
      handled += ids.length;
      continue;
    }

    const single = items.length === 1 ? items[0] : null;
    const subject = single ? single.title : `${items.length} new notifications in BabulTech CRM`;
    const message = single
      ? single.body ?? ""
      : items.slice(0, 30).map((i) => `• ${i.title}`).join("\n") +
        (items.length > 30 ? `\n…and ${items.length - 30} more.` : "");
    const link = single?.link ? `${APP_URL}${single.link}` : `${APP_URL}/notifications`;

    const { html, text } = renderDocumentEmail({
      branding,
      documentTitle: subject,
      message,
      summary: [],
      action: { label: single ? "Open it" : "See them all", url: link },
      senderName: "BabulTech CRM",
    });

    try {
      const { error: sendError } = await mail.emails.send({
        from: FROM,
        to,
        subject,
        html,
        text: `${text}\n\nChoose what reaches you by email: ${APP_URL}/notifications/settings`,
      });
      await mark(ids, sendError ? "FAILED" : "SENT", sendError?.message);
    } catch (err) {
      await mark(ids, "FAILED", err instanceof Error ? err.message : String(err));
    }
    handled += ids.length;
  }

  return handled;
}
