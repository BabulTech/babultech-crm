import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { supabaseAdmin } from "./supabase";
import { isReservedAddress } from "./notification-mailer";
import { renderDocumentEmail, brandingFromSettings, emailSettingsFromRow, EMAIL_SETTINGS_ID } from "./email-template";

/**
 * The Monday summary: last week's Company overview figures, emailed to every
 * active Super Admin and CRM Admin. Runs as a background job queued by
 * pg_cron (company_weekly_summary_tick), so it needs no one signed in.
 */

interface Overview {
  period: { from: string; to: string };
  current: Record<string, number>;
  previous: Record<string, number>;
  sales: { pipelineValue: number; openDeals: number; closingThisMonth: number; pastCloseDate: number };
  delivery: { activeProjects: number; byHealth: { GREEN: number; AMBER: number; RED: number }; overdueTasks: number };
  money: { outstanding: number; overdueCount: number; overdueValue: number };
  attention: Record<string, number>;
  team: { name: string; touches: number; qualified: number; won: number; hours: number }[];
}

const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString("en-US")}`;
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const change = (now: number, before: number) => {
  if (!before) return now ? "new" : "no change";
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "no change" : `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the week before`;
};
const day = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

/** Last Monday to Sunday, in Pakistan time. */
export function lastWeek(now = new Date()): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(d.getTime() - dow * 86_400_000);
  const from = new Date(thisMonday.getTime() - 7 * 86_400_000);
  const to = new Date(thisMonday.getTime() - 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Builds last week's summary and works out who receives it, without sending. */
export async function buildWeeklySummary() {
  const db = supabaseAdmin();
  const { from, to } = lastWeek();
  const { data, error } = await db.rpc("company_overview", { p_from: from, p_to: to });
  if (error) throw new Error(`Could not build the summary: ${error.message}`);
  const o = data as Overview;
  const c = o.current, p = o.previous;

  // Every active Super Admin and CRM Admin.
  const { data: users } = await db.from("app_user")
    .select("id, \"fullName\", email, \"notificationEmail\", role:security_role ( permissions )")
    .eq("status", "ACTIVE").is("deletedAt", null).is("partnerId", null);
  const recipients = (users ?? []).filter((u) => {
    const role = (Array.isArray(u.role) ? u.role[0] : u.role) as { permissions?: string[] } | null;
    const perms = role?.permissions ?? [];
    return perms.includes("*") || perms.includes("all:except-delete");
  });

  const { data: settings } = await db.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const { data: company } = await db.from("company_setting").select("\"publicAppUrl\"").maybeSingle();
  const base = String(company?.publicAppUrl || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const a = o.attention;
  // Last week's timesheets: how many are in, and how many fell short of their hours.
  const [{ data: people }, { data: sheets }] = await Promise.all([
    db.rpc("timesheet_people"),
    db.from("weekly_timesheet").select("status, \"loggedHours\", \"committedHours\"").eq("weekStart", from),
  ]);
  const staff = (people ?? []).length;
  const sheetsIn = (sheets ?? []).filter((s) => s.status === "SUBMITTED" || s.status === "APPROVED");
  const shortWeeks = sheetsIn.filter((s) => Number(s.loggedHours) < Number(s.committedHours)).length;
  const top = o.team.slice(0, 5).map((t) => `<li>${t.name}: ${num(t.touches)} outreach touches, ${t.qualified} qualified, ${t.won} deals won, ${num(t.hours)} hours</li>`).join("");

  const messageHtml =
    `<p>Here is how ${branding.companyName} did from ${day(from)} to ${day(to)}.</p>` +
    `<p><strong>Growth.</strong> ${num(c.prospectsAdded)} prospects added, ${num(c.outreachTouches)} outreach calls and emails (${change(c.outreachTouches, p.outreachTouches)}), ${c.prospectsQualified} qualified to leads, ${c.leadsCreated} new leads.</p>` +
    `<p><strong>Sales.</strong> ${c.dealsWon} deals won worth ${pkr(c.dealsWonValue)} (${change(c.dealsWonValue, p.dealsWonValue)}), ${c.dealsLost} lost. Open pipeline ${pkr(o.sales.pipelineValue)} across ${o.sales.openDeals} deals; ${o.sales.closingThisMonth} expected to close this month, ${o.sales.pastCloseDate} past their close date.</p>` +
    `<p><strong>Money.</strong> Invoiced ${pkr(c.invoiced)}, collected ${pkr(c.collected)} (${change(c.collected, p.collected)}), spent ${pkr(c.expenses)}. Outstanding ${pkr(o.money.outstanding)}, of which ${pkr(o.money.overdueValue)} is overdue on ${o.money.overdueCount} invoices.</p>` +
    `<p><strong>Delivery.</strong> ${o.delivery.activeProjects} active projects: ${o.delivery.byHealth.GREEN} green, ${o.delivery.byHealth.AMBER} amber, ${o.delivery.byHealth.RED} red. ${num(c.hoursLogged)} hours logged; ${o.delivery.overdueTasks} tasks overdue.</p>` +
    (staff ? `<p><strong>Timesheets.</strong> ${sheetsIn.length} of ${staff} submitted, ${(sheets ?? []).filter((s) => s.status === "APPROVED").length} approved, ${shortWeeks} short of their committed hours, ${staff - sheetsIn.length} not submitted.</p>` : "") +
    (top ? `<p><strong>Team.</strong></p><ul>${top}</ul>` : "") +
    `<p><strong>Needs a decision.</strong> ${a.approvals} approvals waiting, ${a.casesBreached} support cases past their deadline, ${a.contractsExpiring} contracts ending within 60 days, ${a.staleLeads} leads untouched for a week.</p>`;

  const summary = [
    { label: "Deals won", value: pkr(c.dealsWonValue), emphasis: true },
    { label: "Collected", value: pkr(c.collected) },
    { label: "Open pipeline", value: pkr(o.sales.pipelineValue) },
    { label: "Overdue", value: pkr(o.money.overdueValue) },
  ];
  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: `Weekly summary, ${day(from)} to ${day(to)}`,
    message: "",
    messageHtml,
    summary,
    action: base ? { label: "Open the Company overview", url: `${base}/overview` } : undefined,
    senderName: `${branding.companyName} CRM`,
  });

  const subject = `${branding.companyName} weekly summary: ${day(from)} to ${day(to)}`;
  return {
    subject, html, text,
    recipients: recipients.map((u) => ({ id: String(u.id), name: String(u.fullName), to: String(u.notificationEmail || u.email) })),
  };
}

export async function sendWeeklySummary(): Promise<{ sent: number; failed: number; errors: string[] }> {
  const db = supabaseAdmin();
  const { subject, html, text, recipients } = await buildWeeklySummary();
  const key = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
  const result = { sent: 0, failed: 0, errors: [] as string[] };
  for (const u of recipients) {
    const to = u.to;
    if (isReservedAddress(to)) continue;
    const rowId = randomUUID();
    const now = new Date().toISOString();
    await db.from("email").insert({
      id: rowId, updatedAt: now, direction: "OUTBOUND", subject, fromAddress, toAddresses: [to], bodyHtml: html, bodyText: text,
      relatedEntityType: "User", relatedEntityId: u.id, sentReceivedAt: now, status: key ? "DRAFT" : "FAILED", hasAttachments: false,
    });
    if (!key) { result.failed++; result.errors.push("Email is not set up on this server (RESEND_API_KEY)."); continue; }
    const sent = await new Resend(key).emails.send({ from: fromAddress, to: [to], subject, html, text });
    await db.from("email").update(sent.error ? { status: "FAILED", updatedAt: new Date().toISOString() } : { status: "SENT", messageId: sent.data?.id ?? null, updatedAt: new Date().toISOString() }).eq("id", rowId);
    if (sent.error) { result.failed++; result.errors.push(`${to}: ${sent.error.message}`); } else result.sent++;
  }
  return result;
}
