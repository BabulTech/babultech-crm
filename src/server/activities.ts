"use server";

import { deleteToRecycleBin } from "./recycle-bin";
import { describeInvalid } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { ACTIVITY_ENTITIES, type ActivityEntity } from "@/lib/activity-entities";
import type { ActionResult } from "./partners";
import type { SendResult } from "@/lib/lead-mailer";

/**
 * Activities: what we did, against whatever we did it to.
 *
 * One table for leads, customers and partners. They differ only in what they
 * point at - ("relatedEntityType", "relatedEntityId") - and three tables would
 * mean three schemas, three sets of policies and three places to fix every bug,
 * while making "everything we did with this partner" and "every email this
 * month" two unrelated queries instead of one.
 *
 * Three kinds matter here:
 *
 *   EMAIL  something we sent, with what the provider told us happened to it
 *   EVENT  a webinar, a meeting, a visit - something with a time and a place
 *   LOG    a record of contact after the fact: a call made, a message sent
 *
 * TASK, CALL, MEETING and REMINDER are still in use by My Work, the account
 * health panel and the dashboard stream, so they remain valid.
 *
 * Not to be confused with partner MESSAGES. An activity is our internal record
 * of what we did; a partner message is a conversation the partner can read and
 * reply to. Merging them would publish internal notes to partners.
 */



export interface ActivityRow {
  id: string;
  activityType: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  outcome: string | null;
  location: string | null;
  startAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;
  /** Email only. */
  toAddress: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  unsubscribedAt: string | null;
  openCount: number;
  clickCount: number;
  failReason: string | null;
  batchId: string | null;
  owner?: { id: string; fullName: string } | null;
}

const SELECT = `
  id, activityType, subject, description, status, priority, outcome, location,
  startAt, dueAt, completedAt, relatedEntityType, relatedEntityId, createdAt,
  toAddress, sentAt, deliveredAt, openedAt, clickedAt, bouncedAt,
  unsubscribedAt, openCount, clickCount, failReason, batchId,
  owner:app_user!activity_ownerUserId_fkey ( id, fullName )
`;

/** Reading a record's activities takes that record's own read permission. */
const ACTIVITY_READ: Record<ActivityEntity, (typeof PERMISSIONS)[keyof typeof PERMISSIONS]> = {
  Lead: PERMISSIONS.LEAD_READ,
  Contact: PERMISSIONS.ACCOUNT_READ,
  Account: PERMISSIONS.ACCOUNT_READ,
  Partner: PERMISSIONS.PARTNER_READ,
  Opportunity: PERMISSIONS.OPPORTUNITY_READ,
};

/**
 * Everything done against one record, newest first.
 *
 * Ordered by when it happened rather than when it was entered: somebody logging
 * yesterday's call today wants it to appear where yesterday was.
 */
export async function listActivitiesFor(
  entityType: ActivityEntity,
  entityId: string,
): Promise<ActivityRow[]> {
  await requirePermission(ACTIVITY_READ[entityType]);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("activity")
    .select(SELECT)
    .eq("relatedEntityType", entityType)
    .eq("relatedEntityId", entityId)
    .is("deletedAt", null)
    .order("createdAt", { ascending: false })
    .limit(200);

  if (error) throw new Error(`Could not load activities: ${error.message}`);

  return (data ?? []).map((a) => ({
    ...a,
    owner: one(a.owner as never),
  })) as unknown as ActivityRow[];
}

const activitySchema = z.object({
  id: z.string().uuid().optional().nullable(),
  activityType: z.enum(["EMAIL", "EVENT", "LOG", "TASK", "CALL", "MEETING", "REMINDER"]),
  subject: z.string().trim().min(1, "An activity needs a subject.").max(255),
  description: z.string().trim().max(8000).optional().or(z.literal("")),
  relatedEntityType: z.enum(ACTIVITY_ENTITIES),
  relatedEntityId: z.string().uuid(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]).default("COMPLETED"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  outcome: z.string().trim().max(4000).optional().or(z.literal("")),
  location: z.string().trim().max(255).optional().or(z.literal("")),
  startAt: z.string().optional().or(z.literal("")),
  dueAt: z.string().optional().or(z.literal("")),
});

const nullable = (v: string | undefined | null) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Log or schedule an activity by hand.
 *
 * Defaults to COMPLETED rather than OPEN, because most of what goes in here is
 * recorded after the fact - a call that has already happened. An activity with
 * a due date in the future is the exception, and the form sets OPEN for it.
 */
export async function saveActivity(
  input: z.infer<typeof activitySchema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.LEAD_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = activitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const row = {
    activityType: d.activityType,
    subject: d.subject,
    description: nullable(d.description),
    relatedEntityType: d.relatedEntityType,
    relatedEntityId: d.relatedEntityId,
    status: d.status,
    priority: d.priority,
    outcome: nullable(d.outcome),
    location: nullable(d.location),
    startAt: nullable(d.startAt),
    dueAt: nullable(d.dueAt),
    completedAt: d.status === "COMPLETED" ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  };

  const db = await supabaseServer();

  const { data, error } = d.id
    ? await db.from("activity").update(row).eq("id", d.id).select("id").maybeSingle()
    : await db
        .from("activity")
        .insert({ id: randomUUID(), ownerUserId: auth.user.id, ...row })
        .select("id")
        .single();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That activity no longer exists." };

  revalidatePath("/activities");
  return { ok: true, data: { id: data.id as string } };
}

/** Only the Super Admin deletes; this is the recycle bin's delete, kept for its callers. */
export async function deleteActivity(id: string, reason?: string | null): Promise<ActionResult> {
  return deleteToRecycleBin("Activity", id, reason) as never;
}

// ---------------------------------------------------------------------------
// Mass email, from the leads list
// ---------------------------------------------------------------------------

export type { SendResult } from "@/lib/lead-mailer";

// The compose screen and its send are in server/communications.ts, shared
// with contacts and campaign members.

// ---------------------------------------------------------------------------
// How a send performed
// ---------------------------------------------------------------------------

export interface EmailStats {
  audience: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  failed: number;
}

/**
 * Counted from the activities every time rather than stored on the batch.
 *
 * A stored total and the rows it came from disagree eventually - a webhook
 * arrives late, a row is corrected - and when they disagree the stored one is
 * believed, because it is the one on the screen.
 */
function tally(rows: Record<string, unknown>[]): EmailStats {
  return {
    audience: rows.length,
    sent: rows.filter((r) => r.sentAt).length,
    delivered: rows.filter((r) => r.deliveredAt).length,
    opened: rows.filter((r) => r.openedAt).length,
    clicked: rows.filter((r) => r.clickedAt).length,
    bounced: rows.filter((r) => r.bouncedAt).length,
    unsubscribed: rows.filter((r) => r.unsubscribedAt).length,
    failed: rows.filter((r) => r.failReason).length,
  };
}

const STAT_COLUMNS =
  "sentAt, deliveredAt, openedAt, clickedAt, bouncedAt, unsubscribedAt, failReason";

export interface EmailBatchSummary {
  id: string;
  subject: string;
  sentAt: string;
  skippedCount: number;
  sentBy?: { fullName: string } | null;
  stats: EmailStats;
}

/** Every send, newest first, each with its own scorecard. */
export async function listEmailBatches(limit = 50): Promise<EmailBatchSummary[]> {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  const { data: batches, error } = await db
    .from("email_batch")
    .select(`id, subject, sentAt, skippedCount,
             sentBy:app_user!email_batch_sentById_fkey ( fullName )`)
    .order("sentAt", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load sends: ${error.message}`);
  if (!batches?.length) return [];

  // One query for every batch's rows rather than one per batch.
  const { data: rows } = await db
    .from("activity")
    .select(`batchId, ${STAT_COLUMNS}`)
    .in("batchId", batches.map((b) => b.id as string));

  const byBatch = new Map<string, Record<string, unknown>[]>();
  for (const r of rows ?? []) {
    const key = r.batchId as string;
    if (!byBatch.has(key)) byBatch.set(key, []);
    byBatch.get(key)!.push(r as Record<string, unknown>);
  }

  return batches.map((b) => ({
    id: b.id as string,
    subject: b.subject as string,
    sentAt: b.sentAt as string,
    skippedCount: (b.skippedCount as number) ?? 0,
    sentBy: one(b.sentBy as never),
    stats: tally(byBatch.get(b.id as string) ?? []),
  }));
}

/**
 * How every email to a campaign's leads has performed.
 *
 * Grouped through the LEAD rather than off the batch. A single send may go to
 * leads from several campaigns, so stamping a campaign on the batch would
 * credit all of it to one of them; going through the lead gives each campaign
 * only its own, however mixed the audience was.
 */
export async function getCampaignEmailStats(campaignId: string): Promise<EmailStats> {
  await requirePermission(PERMISSIONS.LEAD_READ);
  const db = await supabaseServer();

  const { data: leads } = await db
    .from("lead")
    .select("id")
    .eq("campaignId", campaignId)
    .is("deletedAt", null);

  const leadIds = (leads ?? []).map((l) => l.id as string);
  if (!leadIds.length) return tally([]);

  const { data: rows } = await db
    .from("activity")
    .select(STAT_COLUMNS)
    .eq("activityType", "EMAIL")
    .eq("relatedEntityType", "Lead")
    .in("relatedEntityId", leadIds)
    .is("deletedAt", null);

  return tally((rows ?? []) as Record<string, unknown>[]);
}
