import { randomUUID } from "node:crypto";
import { Resend } from "@/lib/mail";
import { supabaseAdmin } from "./supabase";
import { isReservedAddress } from "./notification-mailer";
import { renderDocumentEmail, brandingFromSettings, emailSettingsFromRow, EMAIL_SETTINGS_ID } from "./email-template";
import { lastWeek } from "./weekly-summary";

/**
 * The Monday timesheet report: last week's committed and logged hours and the
 * approver's notes for everyone who keeps a timesheet (every active employee
 * except Super Admins), emailed to every active internal user. Partners and
 * customer-portal users never receive it. Queued by pg_cron
 * (timesheet_weekly_report_tick) as a 'weekly_timesheet_report' job.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hrs = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");
const day = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

const STATUS: Record<string, string> = { APPROVED: "Approved", RETURNED: "Returned", SUBMITTED: "Waiting for approval" };

export async function buildTimesheetReport() {
  const db = supabaseAdmin();
  const { from, to } = lastWeek();
  const nextMonday = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

  const [{ data: people, error }, { data: sheets }, { data: logs }, { data: users }] = await Promise.all([
    db.rpc("timesheet_people"),
    db.from("weekly_timesheet").select("\"userId\", status, \"committedHours\", \"loggedHours\", remarks").eq("weekStart", from),
    db.from("time_log").select("\"userId\", hours").gte("workDate", from).lt("workDate", nextMonday),
    db.from("app_user").select("id, \"fullName\", email, \"notificationEmail\", \"userType\"")
      .eq("status", "ACTIVE").is("deletedAt", null).is("partnerId", null),
  ]);
  if (error) throw new Error(`Could not list timesheet people: ${error.message}`);

  const sheetBy = new Map((sheets ?? []).map((s) => [String(s.userId), s]));
  const loggedBy = new Map<string, number>();
  for (const l of logs ?? []) loggedBy.set(String(l.userId), (loggedBy.get(String(l.userId)) ?? 0) + Number(l.hours));

  const rows = ((people ?? []) as { userId: string; fullName: string; committed: number }[])
    .map((p) => {
      const s = sheetBy.get(p.userId);
      const committed = Number(s?.committedHours ?? p.committed);
      const logged = s ? Number(s.loggedHours) : loggedBy.get(p.userId) ?? 0;
      const status = s ? STATUS[s.status] ?? s.status : "Not submitted";
      const notes = [status, s?.remarks ? `"${s.remarks}"` : ""].filter(Boolean).join(": ");
      return { name: p.fullName, committed, logged, short: logged < committed, notes };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalC = rows.reduce((t, r) => t + r.committed, 0);
  const totalL = rows.reduce((t, r) => t + r.logged, 0);
  const submitted = rows.filter((r) => r.notes !== "Not submitted").length;
  const short = rows.filter((r) => r.short).length;

  const th = "padding:8px;border-bottom:2px solid #d0d5dd;text-align:left;font-size:12px;color:#475467;";
  const td = "padding:8px;border-bottom:1px solid #eaecf0;font-size:14px;vertical-align:top;";
  const table =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:8px;">` +
    `<thead><tr><th style="${th}">Resource name</th><th style="${th}text-align:right;">Committed hours</th><th style="${th}text-align:right;">Logged hours</th><th style="${th}">Approver notes</th></tr></thead><tbody>` +
    rows.map((r) =>
      `<tr><td style="${td}">${esc(r.name)}</td><td style="${td}text-align:right;">${hrs(r.committed)}</td>` +
      `<td style="${td}text-align:right;${r.short ? "color:#b42318;font-weight:600;" : ""}">${hrs(r.logged)}${r.short ? " (short)" : ""}</td>` +
      `<td style="${td}">${esc(r.notes)}</td></tr>`).join("") +
    `<tr><td style="${td}font-weight:600;">Total</td><td style="${td}text-align:right;font-weight:600;">${hrs(totalC)}</td><td style="${td}text-align:right;font-weight:600;">${hrs(totalL)}</td><td style="${td}"></td></tr>` +
    `</tbody></table>`;

  const { data: settings } = await db.from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const { data: company } = await db.from("company_setting").select("\"publicAppUrl\"").maybeSingle();
  const base = String(company?.publicAppUrl || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");

  const messageHtml =
    `<p>Timesheets for ${day(from)} to ${day(to)}: ${submitted} of ${rows.length} submitted, ${short} short of their committed hours.</p>` +
    (rows.length ? table : "<p>No one keeps a timesheet yet.</p>");

  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: `Weekly timesheets, ${day(from)} to ${day(to)}`,
    message: "",
    messageHtml,
    summary: [
      { label: "Committed", value: `${hrs(totalC)} h` },
      { label: "Logged", value: `${hrs(totalL)} h`, emphasis: true },
      { label: "Submitted", value: `${submitted} of ${rows.length}` },
      { label: "Short weeks", value: String(short) },
    ],
    action: base ? { label: "Open my timesheet", url: `${base}/timesheets` } : undefined,
    senderName: `${branding.companyName} CRM`,
  });

  // Every active employee: internal users, not partners or customers.
  const recipients = (users ?? [])
    .filter((u) => (u.userType ?? "INTERNAL") === "INTERNAL")
    .map((u) => ({ id: String(u.id), to: String(u.notificationEmail || u.email) }));

  return { subject: `Weekly timesheets: ${day(from)} to ${day(to)}`, html, text, rows, recipients };
}

export async function sendTimesheetReport(): Promise<{ sent: number; failed: number; errors: string[] }> {
  const db = supabaseAdmin();
  const { subject, html, text, recipients } = await buildTimesheetReport();
  const key = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
  const result = { sent: 0, failed: 0, errors: [] as string[] };
  for (const u of recipients) {
    if (!u.to || isReservedAddress(u.to)) continue;
    const rowId = randomUUID();
    const now = new Date().toISOString();
    await db.from("email").insert({
      id: rowId, updatedAt: now, direction: "OUTBOUND", subject, fromAddress, toAddresses: [u.to], bodyHtml: html, bodyText: text,
      relatedEntityType: "User", relatedEntityId: u.id, sentReceivedAt: now, status: key ? "DRAFT" : "FAILED", hasAttachments: false,
    });
    if (!key) { result.failed++; result.errors.push("Email is not set up on this server (RESEND_API_KEY)."); continue; }
    const sent = await new Resend(key, "Weekly timesheets").emails.send({ from: fromAddress, to: [u.to], subject, html, text });
    await db.from("email").update(sent.error ? { status: "FAILED", updatedAt: new Date().toISOString() } : { status: "SENT", messageId: sent.data?.id ?? null, updatedAt: new Date().toISOString() }).eq("id", rowId);
    if (sent.error) { result.failed++; result.errors.push(`${u.to}: ${sent.error.message}`); } else result.sent++;
  }
  return result;
}
