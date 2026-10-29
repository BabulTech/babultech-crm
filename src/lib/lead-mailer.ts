import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";
import { isReservedAddress } from "./notification-mailer";
import { loadProspectRecipients } from "./prospect-recipients";

/**
 * Emailing a set of people - leads, contacts or campaign members - shared by our
 * team's mass email and a partner's.
 *
 * Three things a naive loop would not do.
 *
 * It checks the suppression list, which is keyed on the ADDRESS rather than the
 * lead, so one unsubscribe covers every record that person is on.
 *
 * Every message carries an unsubscribe link built from its own activity id,
 * plus a List-Unsubscribe header so the mail client offers its own button.
 * Being easy to leave is what stops people reporting mail as spam instead.
 *
 * It sends in the background. Choosing who gets the email - and who is left
 * out and why - happens while the sender waits, and a row is written for every
 * message. The sending itself is a background job (lib/jobs.ts) working
 * through those rows a hundred at a time, the provider's limit, recording the
 * provider's message id against each so the webhook can match opens and clicks
 * back to the right person later. A send of thousands no longer holds the page
 * open, and one cut off part way carries on where it stopped.
 *
 * Who may email which leads is the caller's business: this sends to exactly the
 * leads it is given. Our team's leads are read under their own permissions; a
 * partner's are read under theirs, which only ever return the partner's own.
 */

export type Audience = "Lead" | "Contact" | "CampaignMember" | "Prospect";

/** The domain the mail provider sends for: the one in EMAIL_FROM. */
export function verifiedDomain(): string | null {
  const from = process.env.EMAIL_FROM ?? "";
  const address = from.replace(/^.*</, "").replace(/>$/, "").trim();
  return address.split("@")[1]?.toLowerCase() ?? null;
}

export interface MailableLead {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
}

export interface SendResult {
  batchId: string;
  /** Messages waiting to go out; the background job sends them. */
  queued: number;
  skipped: number;
  skippedReasons: string[];
}

/**
 * Stops before trailing punctuation, so "see https://example.com." links the
 * address and leaves the full stop as a full stop. Applied after escaping, so
 * it matches &amp; in a query string rather than a raw ampersand.
 */
const BARE_URL = /\bhttps?:\/\/[^\s<]+[^\s<.,:;!?"')\]]/g;

/** Plain text to simple HTML: paragraphs, and nothing a sender did not type. */
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const linked = escaped.replace(
    BARE_URL,
    (url) => `<a href="${url}" style="color:#0b6bcb">${url}</a>`,
  );

  const paragraphs = linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">${paragraphs}</div>`;
}

/** Substitutes the few placeholders a sender may use. */
export function fill(
  template: string,
  person: { firstName: string; lastName: string | null; companyName: string | null },
  senderName?: string | null,
): string {
  return template
    .replace(/\{\{\s*firstName\s*\}\}/g, person.firstName || "there")
    .replace(/\{\{\s*lastName\s*\}\}/g, person.lastName && person.lastName !== "-" ? person.lastName : "")
    .replace(/\{\{\s*companyName\s*\}\}/g, person.companyName ?? "your company")
    .replace(/\{\{\s*senderName\s*\}\}/g, senderName ?? "");
}

/**
 * Works out who a send goes to and records it; the messages go out from the
 * background job the caller queues next.
 */
export async function prepareLeadEmails(opts: {
  leads: MailableLead[];
  subject: string;
  bodyText: string;
  fromName: string | null;
  replyTo: string | null;
  /** The person sending: the batch and every activity are theirs. */
  sentById: string;
  /** Reads the suppression list and writes the batch and its activities. */
  db: SupabaseClient;
  /** Who they are. Leads unless said otherwise. */
  audience?: Audience;
  /** A chosen sender address; on the verified domain, or the send is refused. */
  fromAddress?: string | null;
  senderId?: string | null;
  templateId?: string | null;
}): Promise<{ ok: true; data: SendResult } | { ok: false; error: string }> {
  const { leads, subject, bodyText, fromName, replyTo, sentById, db } = opts;
  const audience: Audience = opts.audience ?? "Lead";
  const fromAddress = opts.fromAddress?.trim().toLowerCase() || null;
  if (fromAddress && fromAddress.split("@")[1] !== verifiedDomain()) {
    return { ok: false, error: `${fromAddress} is not on the domain the mail provider sends for (${verifiedDomain() ?? "none set"}).` };
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "No mail provider is configured, so nothing can be sent." };
  if (!leads.length) return { ok: false, error: "None of those leads could be found." };

  // One lookup for the whole send rather than one per lead.
  const addresses = leads
    .map((l) => l.email?.toLowerCase().trim())
    .filter((e): e is string => Boolean(e));

  const { data: suppressed } = await db
    .from("email_suppression")
    .select("email, reason")
    .in("email", addresses.length ? addresses : ["-"]);

  const suppressionByEmail = new Map(
    (suppressed ?? []).map((s) => [s.email as string, s.reason as string]),
  );

  const sendable: MailableLead[] = [];
  const skippedReasons: string[] = [];
  let skipped = 0;

  // The same address twice in one send would mail somebody twice.
  const seen = new Set<string>();

  for (const l of leads) {
    const name = `${l.firstName} ${l.lastName ?? ""}`.trim();
    const email = l.email?.toLowerCase().trim();

    if (!email) { skipped += 1; skippedReasons.push(`${name}: no email address`); continue; }
    if (seen.has(email)) {
      skipped += 1;
      skippedReasons.push(`${name}: same address as someone else in this send`);
      continue;
    }
    const reason = suppressionByEmail.get(email);
    if (reason) {
      skipped += 1;
      skippedReasons.push(`${name}: ${reason.toLowerCase()}`);
      continue;
    }
    seen.add(email);
    sendable.push(l);
  }

  if (sendable.length === 0) {
    return {
      ok: false,
      error: `Nobody in this selection can be emailed. ${skippedReasons.slice(0, 3).join("; ")}`,
    };
  }

  const batchId = randomUUID();
  const stamp = new Date().toISOString();

  const { error: batchError } = await db.from("email_batch").insert({
    id: batchId,
    subject,
    bodyText,
    fromName,
    replyTo,
    fromAddress,
    senderId: opts.senderId ?? null,
    templateId: opts.templateId ?? null,
    audienceType: audience,
    sentById,
    sentAt: stamp,
    skippedCount: skipped,
    skippedReasons: skippedReasons.slice(0, 50),
    updatedAt: stamp,
  });
  if (batchError) return { ok: false, error: batchError.message };

  // The activity rows are created BEFORE sending, because the unsubscribe link
  // in each message is built from its activity id. Writing them afterwards would
  // mean either a second pass to insert the links or a link that cannot be
  // resolved back to a person.
  const activities = sendable.map((l) => ({ id: randomUUID(), lead: l }));

  const { error: insertError } = await db.from("activity").insert(
    activities.map(({ id, lead }) => ({
      id,
      activityType: "EMAIL",
      subject,
      ownerUserId: sentById,
      relatedEntityType: audience,
      relatedEntityId: lead.id,
      batchId,
      toAddress: lead.email,
      status: "COMPLETED",
      updatedAt: stamp,
    })),
  );
  if (insertError) return { ok: false, error: insertError.message };

  return {
    ok: true,
    data: { batchId, queued: activities.length, skipped, skippedReasons: skippedReasons.slice(0, 20) },
  };
}

/**
 * Sends the next hundred unsent messages of a batch. Called by the background
 * job the send queued, over and over until nothing is left.
 *
 * A message counts as done once it has a provider id (sent) or a fail reason,
 * so a job cut off part way carries on with exactly the ones still owed.
 */
export async function sendNextLeadEmails(batchId: string): Promise<{ processed: number; remaining: number; sent: number; failed: number }> {
  const admin = supabaseAdmin();
  const key = process.env.RESEND_API_KEY;

  const { data: batchRow, error: batchError } = await admin
    .from("email_batch")
    .select("id, subject, bodyText, fromName, replyTo, fromAddress")
    .eq("id", batchId)
    .maybeSingle();
  if (batchError || !batchRow) throw new Error(`The send ${batchId} could not be found.`);

  const { data: rows, error } = await admin
    .from("activity")
    .select("id, relatedEntityType, relatedEntityId, toAddress")
    .eq("batchId", batchId)
    .is("sentAt", null)
    .is("failReason", null)
    .order("id")
    .limit(100);
  if (error) throw new Error(error.message);
  const batch = rows ?? [];
  if (batch.length === 0) return { processed: 0, remaining: 0, sent: 0, failed: 0 };

  // Addresses set aside for examples and testing are never sent to, so a test
  // run cannot email anyone; they are marked, not left waiting.
  const reserved = batch.filter((b) => isReservedAddress((b.toAddress as string | null) ?? ""));
  if (reserved.length) {
    await admin
      .from("activity")
      .update({ failReason: "Test address, not sent", updatedAt: new Date().toISOString() })
      .in("id", reserved.map((b) => b.id));
    return { processed: reserved.length, remaining: 1, sent: 0, failed: reserved.length };
  }

  if (!key) {
    const at = new Date().toISOString();
    await admin
      .from("activity")
      .update({ failReason: "No mail provider is configured.", updatedAt: at })
      .in("id", batch.map((b) => b.id));
    return { processed: batch.length, remaining: 0, sent: 0, failed: batch.length };
  }

  // Names for the placeholders, from whichever kind of person each one is.
  const idsOf = (type: string) => batch.filter((b) => (b.relatedEntityType ?? "Lead") === type).map((b) => b.relatedEntityId as string);
  const [leads, contacts, members, prospects] = await Promise.all([
    idsOf("Lead").length ? admin.from("lead").select("id, firstName, lastName, companyName").in("id", idsOf("Lead")) : { data: [] },
    idsOf("Contact").length ? admin.from("contact").select("id, firstName, lastName, account ( name )").in("id", idsOf("Contact")) : { data: [] },
    idsOf("CampaignMember").length ? admin.from("campaign_member").select("id, firstName, lastName, companyName").in("id", idsOf("CampaignMember")) : { data: [] },
    loadProspectRecipients(admin, idsOf("Prospect")),
  ]);
  const leadById = new Map<string, { firstName: string; lastName: string | null; companyName: string | null }>();
  for (const l of [...(leads.data ?? []), ...(members.data ?? []), ...prospects]) {
    leadById.set(l.id as string, { firstName: l.firstName as string, lastName: (l.lastName as string | null) ?? null, companyName: (l.companyName as string | null) ?? null });
  }
  for (const c of contacts.data ?? []) {
    const account = (Array.isArray(c.account) ? c.account[0] : c.account) as { name?: string } | null;
    leadById.set(c.id as string, { firstName: c.firstName as string, lastName: (c.lastName as string | null) ?? null, companyName: account?.name ?? null });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const from = process.env.EMAIL_FROM ?? "BabulTech <onboarding@resend.dev>";

  // The company's icon and name at the top, as on every other email.
  const { data: brand } = await admin.from("email_settings").select("logoUrl, companyName").limit(1).maybeSingle();
  const brandName = String(brand?.companyName ?? "BabulTech").replace(/[<>&"]/g, "");
  const logo = typeof brand?.logoUrl === "string" && /^https:\/\//.test(brand.logoUrl) ? brand.logoUrl.replace(/"/g, "") : null;
  const header = logo
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>` +
      `<td style="vertical-align:middle"><img src="${logo}" alt="" width="32" height="32" style="display:block;border:0;width:32px;height:32px;border-radius:7px"></td>` +
      `<td style="vertical-align:middle;padding-left:9px;font-family:system-ui,sans-serif;font-size:16px;font-weight:700;color:#0F172A">${brandName}</td>` +
      `</tr></table>`
    : "";
  const fromName = batchRow.fromName as string | null;
  // The chosen sender address when it is on the verified domain, which was
  // checked when the send was made; otherwise the system address.
  const chosen = (batchRow.fromAddress as string | null) ?? null;
  const address = chosen && chosen.split("@")[1] === verifiedDomain() ? chosen : from.replace(/^.*</, "").replace(/>$/, "");
  const fromLine = fromName ? `${fromName} <${address}>` : chosen ? address : from;

  const payload = batch.map((row) => {
    const lead = leadById.get(row.relatedEntityId as string) ?? { firstName: "there", lastName: null, companyName: null };
    const unsubscribe = `${appUrl}/unsubscribe/${row.id}`;
    const body = fill(batchRow.bodyText as string, lead as never, fromName);
    const footer =
      `<hr style="border:0;border-top:1px solid #e5e5e5;margin:28px 0 14px">` +
      `<p style="font-family:system-ui,sans-serif;font-size:12px;color:#777;margin:0">` +
      `You are receiving this because you are on our mailing list. ` +
      `<a href="${unsubscribe}" style="color:#777">Unsubscribe</a>.</p>`;

    return {
      from: fromLine,
      to: row.toAddress as string,
      replyTo: (batchRow.replyTo as string | null) ?? undefined,
      subject: fill(batchRow.subject as string, lead as never, fromName),
      html: header + textToHtml(body) + footer,
      text: `${body}

---
Unsubscribe: ${unsubscribe}`,
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  });

  const result = await new Resend(key).batch.send(payload);
  const at = new Date().toISOString();
  let sent = 0;
  let failed = 0;

  if (result.error) {
    failed = batch.length;
    await admin
      .from("activity")
      .update({ failReason: result.error.message.slice(0, 500), updatedAt: at })
      .in("id", batch.map((b) => b.id));
  } else {
    const ids = (result.data?.data ?? []) as { id: string }[];
    for (let j = 0; j < batch.length; j += 1) {
      await admin
        .from("activity")
        .update({ sentAt: at, providerMessageId: ids[j]?.id ?? null, updatedAt: at })
        .eq("id", batch[j].id);
    }
    sent = batch.length;
  }

  const { count } = await admin
    .from("activity")
    .select("id", { count: "exact", head: true })
    .eq("batchId", batchId)
    .is("sentAt", null)
    .is("failReason", null);

  return { processed: batch.length, remaining: count ?? 0, sent, failed };
}

