import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fileReceivedEmail, webhookSecret } from "@/lib/email-replies";

/**
 * What the mail provider tells us happened to a campaign email.
 *
 * This is a public endpoint, so the signature check is the whole of its
 * security. Resend signs with Svix headers: an id, a timestamp and one or more
 * base64 signatures over `id.timestamp.body`, keyed by a secret that starts
 * `whsec_`. Verified here by hand rather than with the Svix library, which is
 * a dependency for ninety lines of HMAC.
 *
 * Without RESEND_WEBHOOK_SECRET set, every request is refused. An unverified
 * endpoint that writes to the database is an invitation to have anyone's
 * campaign statistics filled in by a stranger.
 */

/** Five minutes, to bound how long a captured request stays replayable. */
const TOLERANCE_SECONDS = 300;

function verify(secret: string, id: string, timestamp: string, body: string, header: string): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  // The secret is base64 after its prefix.
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

  // The header carries space-separated "v1,<signature>" pairs; a rotation
  // period has more than one, and any of them matching is a pass.
  for (const part of header.split(" ")) {
    const [version, signature] = part.split(",");
    if (version !== "v1" || !signature) continue;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Which timestamp column each event fills in. */
const EVENT_COLUMN: Record<string, string> = {
  "email.sent": "sentAt",
  "email.delivered": "deliveredAt",
  "email.opened": "openedAt",
  "email.clicked": "clickedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
};

export async function POST(request: Request) {
  const secret = await webhookSecret();
  if (!secret) {
    return NextResponse.json({ error: "Webhooks are not configured." }, { status: 503 });
  }

  const body = await request.text();
  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");

  if (!id || !timestamp || !signature || !verify(secret, id, timestamp, body, signature)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let event: { type?: string; data?: { email_id?: string; to?: string[] } };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Not JSON." }, { status: 400 });
  }

  // A reply to one of our emails: filed on its record, its sender told.
  if (event.type === "email.received" && event.data?.email_id) {
    try {
      await fileReceivedEmail(event.data.email_id);
    } catch (err) {
      // A 500 makes Resend retry, which is right when the read failed.
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not file it." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  const column = EVENT_COLUMN[event.type ?? ""];
  const messageId = event.data?.email_id;

  // Anything we do not track is accepted rather than refused: a non-2xx makes
  // the provider retry forever over an event we were never going to store.
  if (!column || !messageId) return NextResponse.json({ ok: true });

  const db = supabaseAdmin();
  const now = new Date().toISOString();

  // Emails are now activities against a lead, contact or partner rather than
  // rows in a campaign audience, so the match is on the activity.
  const { data: row } = await db
    .from("activity")
    .select("id, toAddress, openCount, clickCount, openedAt, clickedAt, relatedEntityType, relatedEntityId, campaignId, subject")
    .eq("providerMessageId", messageId)
    .maybeSingle();

  if (!row) return NextResponse.json({ ok: true });

  const update: Record<string, unknown> = { updatedAt: now };

  // The first time is what the date records; the count records every time.
  // Somebody who opens a message four times is more interested than somebody
  // who opened it once, and one timestamp cannot say so.
  if (column === "openedAt") {
    update.openedAt = row.openedAt ?? now;
    update.openCount = (row.openCount ?? 0) + 1;
  } else if (column === "clickedAt") {
    update.clickedAt = row.clickedAt ?? now;
    update.clickCount = (row.clickCount ?? 0) + 1;
    // A click implies an open that the pixel may well have missed.
    update.openedAt = row.openedAt ?? now;
  } else {
    update[column] = now;
  }

  await db.from("activity").update(update).eq("id", row.id);

  // The first open and the first click are campaign touches on the person, for
  // their latest source, their score and the campaign's funnel. Once each: the
  // key makes a repeat a no-op.
  if ((column === "openedAt" || column === "clickedAt") && ["Lead", "Contact", "CampaignMember"].includes(row.relatedEntityType as string)) {
    let campaignId = (row.campaignId as string | null) ?? null;
    let person: { leadId?: string; contactId?: string; campaignMemberId?: string } = {};
    if (row.relatedEntityType === "Lead") {
      person = { leadId: row.relatedEntityId as string };
      if (!campaignId) {
        const { data: lead } = await db.from("lead").select("campaignId").eq("id", row.relatedEntityId).maybeSingle();
        campaignId = (lead?.campaignId as string | null) ?? null;
      }
    } else if (row.relatedEntityType === "Contact") {
      person = { contactId: row.relatedEntityId as string };
    } else {
      // A campaign member counts through the lead or contact they became.
      const { data: m } = await db.from("campaign_member").select("leadId, contactId, campaignId").eq("id", row.relatedEntityId).maybeSingle();
      campaignId = campaignId ?? ((m?.campaignId as string | null) ?? null);
      if (m?.leadId) person = { leadId: m.leadId as string, campaignMemberId: row.relatedEntityId as string };
      else if (m?.contactId) person = { contactId: m.contactId as string, campaignMemberId: row.relatedEntityId as string };
    }
    const kind = column === "openedAt" ? "EMAIL_OPEN" : "EMAIL_CLICK";
    if (person.leadId || person.contactId) await db.rpc("record_campaign_interaction", {
      p: {
        ...person,
        campaignId,
        interactionType: kind,
        source: "Email",
        medium: "email",
        details: row.subject ? `Email: ${row.subject}` : null,
        sourceKey: `email:${row.id}:${kind}`,
      },
    });
  }

  // A hard bounce or a spam complaint is about the ADDRESS, not this one send.
  // Both must stop future mail reaching it, or the domain's sending reputation
  // goes and the invoices stop arriving too.
  //
  // Written to the suppression list rather than to the record we happened to
  // mail, because the same person may exist as several leads - they came from
  // two campaigns - and suppressing one copy would leave the others mailable.
  const address = (row.toAddress as string | null)?.toLowerCase().trim();

  if (address && (event.type === "email.bounced" || event.type === "email.complained")) {
    const bounced = event.type === "email.bounced";
    await db.from("email_suppression").upsert(
      {
        email: address,
        reason: bounced ? "BOUNCED" : "COMPLAINED",
        notes: bounced
          ? "Mail to this address hard-bounced"
          : "Reported an email as spam",
        sourceActivityId: row.id as string,
        suppressedAt: now,
      },
      // An address already suppressed stays as it was: the earliest reason is
      // the true one, and a later bounce does not undo an unsubscribe.
      { onConflict: "email", ignoreDuplicates: true },
    );
  }

  return NextResponse.json({ ok: true });
}
