"use server";

import { randomUUID } from "node:crypto";
import { Resend } from "@/lib/mail";
import { supabaseAdmin } from "@/lib/supabase";
import { formatMoney, formatDate } from "@/lib/utils";
import { renderDocumentEmail, type EmailBranding } from "@/lib/email-template";

/**
 * Expense approval notifications.
 *
 * Two moments matter to somebody who is not looking at the screen:
 *
 *   submitted -> everyone who can approve hears that money is waiting on them
 *   decided   -> the person who is out of pocket hears the answer
 *
 * Deliberately best-effort. A notification that fails must never roll back the
 * approval it is reporting: the decision is the real work and it is already
 * written. Failures are recorded on the `email` row as FAILED and returned, and
 * the caller logs rather than surfacing them.
 *
 * The service-role client is used throughout. The recipient list joins
 * security_role, which has no SELECT policy and so is invisible to a normal
 * client, and the claimant may sit outside the approver's data scope.
 */

const FROM = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key, "Expense notification") : null;
}

const SETTINGS_ID = "00000000-0000-0000-0000-000000000001";

/**
 * The address a notification should actually be delivered to.
 *
 * Applied at the point of sending rather than when the recipient list is built,
 * so the audit row records where the mail really went. A trail saying it went
 * to an address that never received it would be worse than no trail.
 */
/**
 * Per-user delivery overrides, keyed by user id.
 *
 * Read in its own query rather than joined into the recipient select, because
 * naming a column PostgREST does not know fails the ENTIRE query — so a
 * database that has not run the notificationEmail migration yet would lose
 * notifications altogether rather than just the override. Asking separately
 * means a missing column costs nothing: the map comes back empty and delivery
 * falls through to EMAIL_REDIRECTS and then the sign-in address.
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

function deliverTo(
  people: { id: string; email: string }[],
  overrides: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const person of people) {
    // The override set in Users wins; otherwise mail goes to the sign-in
    // address. Set an override while the real mailbox does not exist, and clear
    // it once it does.
    const target = overrides.get(person.id) || person.email;

    // Several people can route to one shared inbox; sending twice would be a
    // duplicate rather than a second notification.
    if (seen.has(target.toLowerCase())) continue;
    seen.add(target.toLowerCase());
    out.push(target);
  }

  return out;
}

/** Branding read with the service role, since this runs outside a user request. */
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

/** Mirrors lib/authz.ts `can()`, so the recipients are exactly who may act. */
function hasPermission(permissions: string[] | null, permission: string): boolean {
  const list = permissions ?? [];
  if (list.includes("*") || list.includes(permission)) return true;
  const [entity, action] = permission.split(":");
  return list.includes(`${entity}:*`) || list.includes(`*:${action}`);
}

type ExpenseRow = {
  id: string;
  expenseNumber: string;
  amount: string | number;
  currencyCode: string;
  expenseDate: string;
  description: string | null;
  employeeUserId: string | null;
};

/** Writes the email row, sends it, and records the outcome either way. */
async function send(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  expenseId: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.to.length) return { ok: true };

  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const rowId = randomUUID();

  const base = {
    id: rowId,
    updatedAt: now,
    direction: "OUTBOUND",
    subject: input.subject,
    fromAddress: FROM,
    toAddresses: input.to,
    bodyHtml: input.html,
    bodyText: input.text,
    relatedEntityType: "Expense",
    relatedEntityId: input.expenseId,
    sentReceivedAt: now,
    hasAttachments: false,
  };

  const resend = client();
  if (!resend) {
    // Recorded rather than sent, so the trail still shows what would have gone
    // out on a machine with no mail configured.
    await db.from("email").insert({ ...base, status: "FAILED" });
    return { ok: false, error: "RESEND_API_KEY is not set." };
  }

  await db.from("email").insert({ ...base, status: "DRAFT" });

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
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

/**
 * Tells the approvers that an expense is waiting on them.
 *
 * Recipients are everyone holding expense:approve, minus the claimant, who
 * cannot approve their own claim and would only be receiving noise.
 *
 * This followed invoice:approve until 20260919000001. Expenses moved onto
 * expense:approve back in 20260830000000, so the notification was going to
 * whoever ran the receivables ledger rather than to whoever could actually
 * decide the claim.
 */
export async function notifyExpenseSubmitted(
  expenseIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!expenseIds.length) return { ok: true };

  const db = supabaseAdmin();

  const { data: expenses } = await db
    .from("expense")
    .select("id, expenseNumber, amount, currencyCode, expenseDate, description, employeeUserId")
    .in("id", expenseIds);

  if (!expenses?.length) return { ok: true };

  const { data: users } = await db
    .from("app_user")
    .select("id, fullName, email, role:security_role ( permissions )")
    .eq("status", "ACTIVE")
    .is("deletedAt", null);

  const overrides = await notificationOverrides(db);

  const claimantIds = new Set(expenses.map((e) => e.employeeUserId).filter(Boolean));

  const approvers = (users ?? []).filter((u) => {
    const role = Array.isArray(u.role) ? u.role[0] : u.role;
    return (
      hasPermission((role as { permissions: string[] } | null)?.permissions ?? null, "expense:approve") &&
      !claimantIds.has(u.id)
    );
  });

  if (!approvers.length) return { ok: true };

  const claimant = (users ?? []).find((u) => claimantIds.has(u.id));
  const rows = expenses as ExpenseRow[];
  const total = rows.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
  const currency = rows[0]?.currencyCode ?? "PKR";
  const single = rows.length === 1 ? rows[0] : null;

  const brand = await branding();
  const { html, text } = renderDocumentEmail({
    branding: brand,
    documentTitle: single
      ? `Expense ${single.expenseNumber} needs approval`
      : `${rows.length} expenses need approval`,
    message: single
      ? `${claimant?.fullName ?? "Someone"} submitted an expense claim for approval.${single.description ? `\n\n${single.description}` : ""}`
      : `${claimant?.fullName ?? "Someone"} submitted ${rows.length} expense claims for approval.`,
    summary: single
      ? [
          { label: "Expense", value: single.expenseNumber },
          { label: "Date", value: formatDate(single.expenseDate) },
          { label: "Submitted by", value: claimant?.fullName ?? "—" },
          { label: "Amount", value: formatMoney(single.amount, single.currencyCode), emphasis: true },
        ]
      : [
          { label: "Claims", value: String(rows.length) },
          { label: "Submitted by", value: claimant?.fullName ?? "—" },
          { label: "Total", value: formatMoney(total, currency), emphasis: true },
        ],
    action: {
      label: single ? "Review this expense" : "Review the expenses",
      url: single ? `${APP_URL}/expenses/${single.id}` : `${APP_URL}/expenses?approvalStatus=SUBMITTED`,
    },
    senderName: claimant?.fullName ?? "BabulTech CRM",
  });

  return send({
    to: deliverTo(approvers, overrides),
    subject: single
      ? `Approval needed: ${single.expenseNumber}, ${formatMoney(single.amount, single.currencyCode)}`
      : `Approval needed: ${rows.length} expenses, ${formatMoney(total, currency)}`,
    html,
    text,
    expenseId: rows[0].id,
  });
}

/**
 * Tells each claimant the outcome.
 *
 * Grouped by claimant rather than sent per expense: approving twenty rows at
 * once should produce one email per person, not twenty.
 */
export async function notifyExpenseDecided(
  expenseIds: string[],
  decision: "APPROVED" | "REJECTED",
  deciderName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!expenseIds.length) return { ok: true };

  const db = supabaseAdmin();

  const { data: expenses } = await db
    .from("expense")
    .select("id, expenseNumber, amount, currencyCode, expenseDate, description, employeeUserId")
    .in("id", expenseIds);

  if (!expenses?.length) return { ok: true };

  const byClaimant = new Map<string, ExpenseRow[]>();
  for (const e of expenses as ExpenseRow[]) {
    if (!e.employeeUserId) continue;
    const list = byClaimant.get(e.employeeUserId) ?? [];
    list.push(e);
    byClaimant.set(e.employeeUserId, list);
  }

  if (!byClaimant.size) return { ok: true };

  const { data: users } = await db
    .from("app_user")
    .select("id, fullName, email")
    .in("id", [...byClaimant.keys()]);

  const overrides = await notificationOverrides(db);

  const brand = await branding();
  const verb = decision === "APPROVED" ? "approved" : "rejected";
  const Verb = verb.charAt(0).toUpperCase() + verb.slice(1);
  const failures: string[] = [];

  for (const [userId, rows] of byClaimant) {
    const user = (users ?? []).find((u) => u.id === userId);
    if (!user?.email) continue;

    const total = rows.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
    const currency = rows[0]?.currencyCode ?? "PKR";
    const single = rows.length === 1 ? rows[0] : null;

    const { html, text } = renderDocumentEmail({
      branding: brand,
      documentTitle: single
        ? `Expense ${single.expenseNumber} ${verb}`
        : `${rows.length} expenses ${verb}`,
      message:
        decision === "APPROVED"
          ? `${deciderName} approved your expense claim. Reimbursement follows once it is settled.`
          : `${deciderName} rejected your expense claim. A rejected claim can be corrected and resubmitted, so talk to them if you think it should stand.`,
      summary: single
        ? [
            { label: "Expense", value: single.expenseNumber },
            { label: "Date", value: formatDate(single.expenseDate) },
            { label: "Decision", value: Verb },
            { label: "Amount", value: formatMoney(single.amount, single.currencyCode), emphasis: true },
          ]
        : [
            { label: "Claims", value: String(rows.length) },
            { label: "Decision", value: Verb },
            { label: "Total", value: formatMoney(total, currency), emphasis: true },
          ],
      action: {
        label: single ? "View this expense" : "View your expenses",
        url: single ? `${APP_URL}/expenses/${single.id}` : `${APP_URL}/expenses`,
      },
      senderName: deciderName,
    });

    const result = await send({
      to: deliverTo([user], overrides),
      subject: single
        ? `Expense ${single.expenseNumber} ${verb}`
        : `${rows.length} expenses ${verb}, ${formatMoney(total, currency)}`,
      html,
      text,
      expenseId: rows[0].id,
    });

    if (!result.ok && result.error) failures.push(result.error);
  }

  return failures.length ? { ok: false, error: failures.join("; ") } : { ok: true };
}
