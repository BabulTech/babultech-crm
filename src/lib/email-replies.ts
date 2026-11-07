import { supabaseAdmin } from "./supabase";
import { richTextToLines } from "./rich-text";

/**
 * A reply comes in: file it where the conversation is.
 *
 * Resend receives the mail and sends only an id; the message itself is read
 * from its API. The reply is matched to the latest email the CRM sent to that
 * address, preferring one whose subject it answers, and filed on the same
 * record. Failing that, on a prospect, lead or contact with that address.
 * Failing that, it is kept unfiled and listed on Received emails, so nothing
 * that arrives is lost.
 */

interface Received {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  subject: string;
  text: string | null;
  html: string | null;
  created_at: string;
  attachments: unknown[];
}

const addressOf = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
const bareSubject = (s: string) => s.replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, "").trim().toLowerCase();

export async function fileReceivedEmail(resendId: string): Promise<{ filed: boolean; emailId?: string }> {
  const db = supabaseAdmin();
  const key = `inbound:${resendId}`;
  const { data: seen } = await db.from("email").select("id").eq("messageId", key).maybeSingle();
  if (seen) return { filed: true, emailId: seen.id as string };

  const res = await fetch(`https://api.resend.com/emails/receiving/${resendId}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Could not read the received email (${res.status}).`);
  const mail = (await res.json()) as Received;

  const from = addressOf(mail.from);
  const subject = mail.subject || "(no subject)";
  const text = (mail.text?.trim() || richTextToLines(mail.html ?? "")).slice(0, 50_000);

  // The email this answers: the latest we sent to this address, preferring a matching subject.
  const { data: sent } = await db.from("email")
    .select("id, subject, relatedEntityType, relatedEntityId, sentById")
    .eq("direction", "OUTBOUND").eq("status", "SENT")
    .or(`toAddresses.cs.${JSON.stringify([from])},ccAddresses.cs.${JSON.stringify([from])}`)
    .order("sentReceivedAt", { ascending: false }).limit(20);
  const candidates = (sent ?? []) as { id: string; subject: string; relatedEntityType: string | null; relatedEntityId: string | null; sentById: string | null }[];
  const original = candidates.find((e) => bareSubject(e.subject) === bareSubject(subject)) ?? candidates[0] ?? null;

  let entityType = original?.relatedEntityType ?? null;
  let entityId = original?.relatedEntityId ?? null;
  if (!entityId) {
    const [prospect, lead, contact] = await Promise.all([
      db.from("prospect_email").select("prospectId").eq("emailNorm", from).limit(1).maybeSingle(),
      db.from("lead").select("id").ilike("email", from).is("deletedAt", null).limit(1).maybeSingle(),
      db.from("contact").select("id").ilike("email", from).is("deletedAt", null).limit(1).maybeSingle(),
    ]);
    if (prospect.data) { entityType = "Prospect"; entityId = prospect.data.prospectId as string; }
    else if (lead.data) { entityType = "Lead"; entityId = lead.data.id as string; }
    else if (contact.data) { entityType = "Contact"; entityId = contact.data.id as string; }
  }

  const now = new Date().toISOString();
  const emailId = crypto.randomUUID();
  const { error } = await db.from("email").insert({
    id: emailId, direction: "INBOUND", status: "RECEIVED", subject: subject.slice(0, 500), fromAddress: mail.from.slice(0, 320),
    toAddresses: mail.to ?? [], ccAddresses: mail.cc?.length ? mail.cc : null, bodyText: text, bodyHtml: null,
    messageId: key, threadId: original?.id ?? null, relatedEntityType: entityType, relatedEntityId: entityId,
    sentReceivedAt: mail.created_at ?? now, hasAttachments: (mail.attachments ?? []).length > 0, createdAt: now, updatedAt: now,
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return { filed: true };
    throw new Error(`Could not store the received email: ${error.message}`);
  }

  // Who hears about it: whoever sent the original, else the record's owner.
  let notifyUser = original?.sentById ?? null;
  if (!notifyUser && entityType && entityId) {
    const table = { Prospect: "prospect", Lead: "lead", Contact: "contact", Account: "account", Opportunity: "opportunity" }[entityType];
    if (table) notifyUser = ((await db.from(table).select("ownerUserId").eq("id", entityId).maybeSingle()).data?.ownerUserId as string | null) ?? null;
  }
  const link = entityType && entityId ? recordPath(entityType, entityId) : "/email/received";
  if (notifyUser) {
    await db.rpc("notify_user", {
      p_user: notifyUser, p_kind: "EMAIL_REPLY", p_title: `Reply from ${mail.from}`.slice(0, 300),
      p_body: `${subject}\n\n${text.slice(0, 500)}`, p_link: link, p_entity_type: entityType, p_entity_id: entityId, p_dedupe: key,
    });
  }

  // On a prospect, a reply is outreach history too.
  if (entityType === "Prospect" && entityId) {
    await db.from("prospect_activity").insert({ prospectId: entityId, type: "EMAIL_REPLY", channel: "business_email", content: `Subject: ${subject}`.slice(0, 2000), occurredAt: mail.created_at ?? now });
  }

  await db.from("activity_event").insert({
    category: "EMAIL", action: "RECEIVED", outcome: "OK",
    summary: `Email from ${from}: ${subject}${entityType ? "" : " (not matched to a record)"}`.slice(0, 500),
    actorName: from, entityType, entityId, detail: { source: "Reply", from: mail.from, to: mail.to, subject, resendId },
  });
  return { filed: true, emailId };
}

const recordPath = (type: string, id: string) =>
  ({ Prospect: `/prospects/${id}`, Lead: `/leads/${id}`, Contact: `/contacts/${id}`, Account: `/accounts/${id}`, Opportunity: `/opportunities/${id}`,
     Quotation: `/quotations/${id}`, Invoice: `/invoices/${id}`, Project: `/projects/${id}`, Case: `/cases/${id}`, CampaignMember: `/campaign-members/${id}` } as Record<string, string>)[type] ?? "/email/received";

/**
 * The webhooks' signing secrets: the one stored at setup, and the hosting
 * setting if there is one. Each webhook in Resend has its own, so a request
 * signed by either is genuine.
 */
export async function webhookSecrets(): Promise<string[]> {
  const { data } = await supabaseAdmin().from("app_secret").select("value").eq("name", "resend_webhook_secret").maybeSingle();
  return [data?.value as string | undefined, process.env.RESEND_WEBHOOK_SECRET].filter((s): s is string => Boolean(s));
}
