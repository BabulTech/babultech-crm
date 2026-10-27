"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requireUser, can } from "@/lib/authz";
import { describeInvalid } from "@/lib/form-errors";
import {
  CAMPAIGN_STATUSES, CHANNELS, QUICK_LOG_ACTIONS, STATUS_SUGGESTION, TOUCH_TYPES, channelAllows, followUpFor, isChannel,
  CHANNEL_LABELS, type CampaignStatus, type Channel,
} from "@/lib/prospect-outreach";
import type { ProspectFilters } from "./prospects";
import type { ActionResult } from "./partners";

/**
 * Prospecting campaigns and outreach, from ORMS. A campaign holds prospects,
 * each with its own status and touch count; Quick log records a call, email
 * or meeting in one step, counts the touch, creates the follow-up task and
 * suggests the next status. Row-level security narrows everything to the
 * campaigns a person may see or work (see prospect_visible_campaigns).
 */

const ENTRY_PAGE = 50;
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

async function requireRead() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) throw new Error("You do not have access to prospects.");
  return me;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export async function listProspectCampaigns() {
  await requireRead();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("prospect_campaign")
    .select("id, name, description, status, \"defaultChannel\", \"followupDays\", \"startDate\", \"endDate\", \"createdAt\", owner:app_user!prospect_campaign_ownerUserId_fkey ( fullName ), members:prospect_campaign_member ( \"userId\" )")
    .is("deletedAt", null)
    .order("createdAt", { ascending: false });
  if (error) throw new Error(`Could not load campaigns: ${error.message}`);
  return Promise.all((data ?? []).map(async (c) => {
    const { data: stats } = await db.rpc("prospect_campaign_stats", { p_campaign: c.id });
    const s = (stats ?? { total: 0, byStatus: {}, touched: 0 }) as { total: number; byStatus: Record<string, number>; touched: number };
    return {
      id: c.id as string, name: c.name as string, description: c.description as string | null, status: c.status as string,
      defaultChannel: c.defaultChannel as string | null, startDate: c.startDate as string | null, endDate: c.endDate as string | null,
      owner: (one(c.owner) as { fullName?: string } | null)?.fullName ?? null,
      teamSize: (c.members as unknown[] | null)?.length ?? 0,
      total: s.total, touched: s.touched, byStatus: s.byStatus,
    };
  }));
}

export async function getProspectCampaign(id: string) {
  await requireRead();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("prospect_campaign")
    .select("*, owner:app_user!prospect_campaign_ownerUserId_fkey ( id, fullName ), members:prospect_campaign_member ( \"userId\", role, user:app_user ( id, fullName, email ) )")
    .eq("id", id).is("deletedAt", null).maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load the campaign: ${error.message}`);
  }
  if (!data) return null;
  const [{ data: stats }, { data: managed }] = await Promise.all([
    db.rpc("prospect_campaign_stats", { p_campaign: id }),
    db.rpc("prospect_campaign_managed", { p_campaign: id }),
  ]);
  return {
    ...data,
    owner: one(data.owner) as { id: string; fullName: string } | null,
    members: ((data.members ?? []) as { userId: string; role: string; user: unknown }[]).map((m) => ({ userId: m.userId, role: m.role, user: one(m.user) as { id: string; fullName: string; email: string } | null })),
    stats: (stats ?? { total: 0, byStatus: {}, touched: 0 }) as { total: number; byStatus: Record<string, number>; touched: number },
    canManage: Boolean(managed),
  };
}

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().nullable().transform((v) => v || null),
  // The New campaign form has no status box: empty means Active.
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED"]).or(z.literal("").transform(() => "ACTIVE" as const)).default("ACTIVE"),
  defaultChannel: z.enum(CHANNELS).optional().nullable().or(z.literal("").transform(() => null)),
  followupDays: z.coerce.number().int().min(1).max(60).default(3),
  startDate: z.string().optional().nullable().transform((v) => v || null),
  endDate: z.string().optional().nullable().transform((v) => v || null),
});

export async function saveProspectCampaign(id: string | null, input: z.input<typeof campaignSchema>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const db = await supabaseServer();
  const row = { ...parsed.data, updatedAt: new Date().toISOString() };
  const result = id
    ? await db.from("prospect_campaign").update(row).eq("id", id).select("id").maybeSingle()
    : await db.from("prospect_campaign").insert({ ...row, ownerUserId: auth.user.id, createdById: auth.user.id }).select("id").single();
  if (result.error) return { ok: false, error: result.error.message };
  if (!result.data) return { ok: false, error: "Only the campaign's owner or a manager can change it." };
  revalidatePath("/prospects/campaigns");
  return { ok: true, data: { id: result.data.id } };
}

/** Adds someone to the campaign's team, changes their role, or (role null) removes them. */
export async function setProspectCampaignMember(campaignId: string, userId: string, role: "manager" | "member" | "viewer" | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const { error } = role
    ? await db.from("prospect_campaign_member").upsert({ campaignId, userId, role })
    : await db.from("prospect_campaign_member").delete().eq("campaignId", campaignId).eq("userId", userId);
  if (error) return { ok: false, error: /row-level security/i.test(error.message) ? "Only the campaign's owner or a manager can change its team." : error.message };
  revalidatePath(`/prospects/campaigns/${campaignId}`);
  return { ok: true, data: undefined };
}

/** People who could be put on a campaign's team or given a task. */
export async function listProspectWorkers() {
  await requireRead();
  const db = await supabaseServer();
  const { data } = await db.from("app_user").select("id, fullName, jobTitle").eq("status", "ACTIVE").is("deletedAt", null).is("partnerId", null).order("fullName");
  return (data ?? []) as { id: string; fullName: string; jobTitle: string | null }[];
}

// ---------------------------------------------------------------------------
// Prospects in a campaign
// ---------------------------------------------------------------------------

export interface CampaignEntryRow {
  id: string; prospectId: string; businessName: string; region: string | null; icpTier: string | null; phone: string | null;
  status: CampaignStatus; touchCount: number; lastContactedAt: string | null; assignedTo: string | null;
}

export async function listCampaignEntries(campaignId: string, filters: { status?: string; search?: string; assigned?: string }, page = 0): Promise<{ rows: CampaignEntryRow[]; total: number }> {
  await requireRead();
  const db = await supabaseServer();
  let q = db.from("prospect_campaign_entry")
    .select("id, \"prospectId\", status, \"touchCount\", \"lastContactedAt\", assignee:app_user!prospect_campaign_entry_assignedUserId_fkey ( fullName ), prospect:prospect!inner ( \"businessName\", region, \"icpTier\", phones:prospect_phone ( phone, \"isPrimary\" ) )", { count: "exact" })
    .eq("campaignId", campaignId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.assigned) q = q.eq("assignedUserId", filters.assigned);
  if (filters.search?.trim()) q = q.ilike("prospect.businessName", `%${filters.search.trim().replace(/[%_,()]/g, "")}%`);
  const { data, error, count } = await q
    .order("lastContactedAt", { ascending: true, nullsFirst: true })
    .order("createdAt", { ascending: true })
    .range(page * ENTRY_PAGE, page * ENTRY_PAGE + ENTRY_PAGE - 1);
  if (error) throw new Error(`Could not load the campaign's prospects: ${error.message}`);
  return {
    total: count ?? 0,
    rows: (data ?? []).map((e) => {
      const p = one(e.prospect) as { businessName: string; region: string | null; icpTier: string | null; phones: { phone: string; isPrimary: boolean }[] } | null;
      return {
        id: e.id, prospectId: e.prospectId, businessName: p?.businessName ?? "", region: p?.region ?? null, icpTier: p?.icpTier ?? null,
        phone: (p?.phones ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0]?.phone ?? null,
        status: e.status as CampaignStatus, touchCount: e.touchCount, lastContactedAt: e.lastContactedAt,
        assignedTo: (one(e.assignee) as { fullName?: string } | null)?.fullName ?? null,
      };
    }),
  };
}

export async function addProspectsToCampaign(campaignId: string, prospectIds: string[]): Promise<ActionResult<{ added: number }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const ids = [...new Set(prospectIds)];
  if (!campaignId || !ids.length) return { ok: false, error: "Choose a campaign and at least one prospect." };
  const db = await supabaseServer();
  let added = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db.from("prospect_campaign_entry")
      .upsert(ids.slice(i, i + 500).map((prospectId) => ({ campaignId, prospectId, addedById: auth.user.id })), { onConflict: "campaignId,prospectId", ignoreDuplicates: true })
      .select("id");
    if (error) return { ok: false, error: /row-level security/i.test(error.message) ? "You are not on this campaign's team." : error.message };
    added += data?.length ?? 0;
  }
  revalidatePath(`/prospects/campaigns/${campaignId}`);
  return { ok: true, data: { added } };
}

/** Adds every prospect matching the prospects list's filters, in the database. */
export async function addFilteredProspectsToCampaign(campaignId: string, filters: ProspectFilters): Promise<ActionResult<{ added: number }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const payload = Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v));
  const { data, error } = await db.rpc("prospect_campaign_add_filtered", { p_campaign: campaignId, p_filters: payload });
  if (error) return { ok: false, error: /row-level security/i.test(error.message) ? "You are not on this campaign's team." : error.message };
  revalidatePath(`/prospects/campaigns/${campaignId}`);
  return { ok: true, data: { added: Number(data ?? 0) } };
}

export async function removeCampaignEntry(entryId: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const { error } = await db.from("prospect_campaign_entry").delete().eq("id", entryId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}

export async function assignCampaignEntries(entryIds: string[], userId: string | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const { error } = await db.from("prospect_campaign_entry").update({ assignedUserId: userId, updatedAt: new Date().toISOString() }).in("id", entryIds);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}

/** Moves a prospect to another status in a campaign, and records the change. */
export async function setCampaignStatus(campaignId: string, prospectId: string, status: CampaignStatus, note?: string | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Status: choose one of the options." };
  const db = await supabaseServer();
  const { data: entry } = await db.from("prospect_campaign_entry").select("id, status").eq("campaignId", campaignId).eq("prospectId", prospectId).maybeSingle();
  if (!entry) return { ok: false, error: "This prospect is not in that campaign." };
  if (entry.status === status) return { ok: true, data: undefined };
  const { error } = await db.from("prospect_campaign_entry").update({ status, updatedAt: new Date().toISOString() }).eq("id", entry.id);
  if (error) return { ok: false, error: error.message };
  await db.from("prospect_activity").insert({ prospectId, campaignId, type: "STATUS_CHANGED", content: note ? `${entry.status} → ${status}: ${note}` : `${entry.status} → ${status}`, actorId: auth.user.id });
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Quick log
// ---------------------------------------------------------------------------

const quickLogSchema = z.object({
  prospectId: z.string().uuid(),
  campaignId: z.string().uuid(),
  action: z.enum(QUICK_LOG_ACTIONS),
  channel: z.enum(CHANNELS).optional().nullable().or(z.literal("").transform(() => null)),
  personId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  note: z.string().max(4000).optional().nullable(),
});

export interface QuickLogResult { taskCreated: string | null; suggestion: CampaignStatus | null; warnings: string[] }

/**
 * Records one piece of outreach: the activity, the touch, the follow-up task,
 * and the status it suggests (offered, never applied without a click).
 */
export async function quickLogProspect(input: z.input<typeof quickLogSchema>): Promise<ActionResult<QuickLogResult>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = quickLogSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error) };
  const { prospectId, campaignId, action, personId, note } = parsed.data;
  const db = await supabaseServer();

  const { data: entry } = await db.from("prospect_campaign_entry")
    .select("id, status, campaign:prospect_campaign ( \"defaultChannel\", \"followupDays\" )")
    .eq("campaignId", campaignId).eq("prospectId", prospectId).maybeSingle();
  if (!entry) return { ok: false, error: "This prospect is not in that campaign." };
  const campaign = one(entry.campaign) as { defaultChannel: string | null; followupDays: number } | null;
  const channel = (campaign?.defaultChannel || parsed.data.channel || null) as Channel | null;
  if (channel !== null && !isChannel(channel)) return { ok: false, error: "Channel: choose one of the options." };
  if (!channelAllows(channel, action)) return { ok: false, error: `That cannot be done by ${CHANNEL_LABELS[channel!].toLowerCase()}. Choose another channel.` };
  if (personId) {
    const { data: person } = await db.from("prospect_person").select("id").eq("id", personId).eq("prospectId", prospectId).maybeSingle();
    if (!person) return { ok: false, error: "Choose a person at this business." };
  }

  const now = new Date();
  const { error } = await db.from("prospect_activity").insert({
    prospectId, campaignId, type: action, channel, personId: personId || null, content: note?.trim() || null, occurredAt: now.toISOString(), actorId: auth.user.id,
  });
  if (error) return { ok: false, error: /row-level security/i.test(error.message) ? "You are not on this campaign's team." : error.message };

  // The activity is saved: anything below is reported, not retried, so the
  // same call is never logged twice.
  const warnings: string[] = [];
  let taskCreated: string | null = null;
  const task = followUpFor(action, campaign?.followupDays ?? 3, now);
  if (task) {
    const { error: taskError } = await db.from("prospect_task").insert({ ...task, prospectId, campaignId, assignedTo: auth.user.id, createdById: auth.user.id });
    if (taskError) warnings.push("Logged, but the follow-up task could not be created. Add one by hand.");
    else taskCreated = `${task.title}, ${task.dueDate}`;
  }
  if (TOUCH_TYPES.includes(action)) {
    const { error: touchError } = await db.rpc("prospect_campaign_touch", { p_campaign: campaignId, p_prospect: prospectId, p_at: now.toISOString() });
    if (touchError) warnings.push("Logged, but the touch count could not be updated.");
  }
  const rule = STATUS_SUGGESTION[action];
  const suggestion = rule && rule.from.includes(entry.status as CampaignStatus) ? rule.to : null;

  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: { taskCreated, suggestion, warnings } };
}

export async function addProspectNote(prospectId: string, campaignId: string | null, text: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  if (!text.trim()) return { ok: false, error: "Note is required." };
  const db = await supabaseServer();
  const { error } = await db.from("prospect_activity").insert({ prospectId, campaignId, type: "NOTE_ADDED", content: text.trim().slice(0, 4000), actorId: auth.user.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: undefined };
}

/** A prospect's campaigns, outreach history and open tasks, for its page. */
export async function getProspectOutreach(prospectId: string) {
  await requireRead();
  const db = await supabaseServer();
  const [entries, activities, tasks] = await Promise.all([
    db.from("prospect_campaign_entry").select("id, \"campaignId\", status, \"touchCount\", \"lastContactedAt\", campaign:prospect_campaign ( name, \"defaultChannel\", \"followupDays\", status )").eq("prospectId", prospectId),
    db.from("prospect_activity").select("id, type, channel, content, \"occurredAt\", \"campaignId\", actor:app_user ( fullName ), person:prospect_person ( name, role ), campaign:prospect_campaign ( name )").eq("prospectId", prospectId).order("occurredAt", { ascending: false }).limit(200),
    db.from("prospect_task").select("id, title, type, \"dueDate\", priority, status, \"campaignId\", assignee:app_user!prospect_task_assignedTo_fkey ( fullName )").eq("prospectId", prospectId).order("status").order("dueDate").limit(100),
  ]);
  return {
    entries: (entries.data ?? []).map((e) => ({ ...e, campaign: one(e.campaign) as { name: string; defaultChannel: string | null; followupDays: number; status: string } | null })),
    activities: (activities.data ?? []).map((a) => ({
      id: a.id, type: a.type, channel: a.channel, content: a.content, occurredAt: a.occurredAt, campaignId: a.campaignId,
      actor: (one(a.actor) as { fullName?: string } | null)?.fullName ?? null,
      person: one(a.person) as { name: string; role: string | null } | null,
      campaign: (one(a.campaign) as { name?: string } | null)?.name ?? null,
    })),
    tasks: (tasks.data ?? []).map((t) => ({ ...t, assignee: (one(t.assignee) as { fullName?: string } | null)?.fullName ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listProspectTasks(filters: { tab?: string; mine?: boolean; campaignId?: string }, page = 0) {
  const me = await requireRead();
  const db = await supabaseServer();
  const today = new Date().toISOString().slice(0, 10);
  let q = db.from("prospect_task")
    .select("id, title, type, \"dueDate\", priority, status, \"completedAt\", \"prospectId\", \"campaignId\", prospect:prospect ( \"businessName\" ), campaign:prospect_campaign ( name ), assignee:app_user!prospect_task_assignedTo_fkey ( fullName )", { count: "exact" });
  if (filters.mine) q = q.eq("assignedTo", me.id);
  if (filters.campaignId) q = q.eq("campaignId", filters.campaignId);
  const tab = filters.tab ?? "today";
  if (tab === "overdue") q = q.eq("status", "open").lt("dueDate", today);
  else if (tab === "today") q = q.eq("status", "open").lte("dueDate", today);
  else if (tab === "upcoming") q = q.eq("status", "open").gt("dueDate", today);
  else q = q.eq("status", "done");
  const { data, error, count } = await q.order(tab === "done" ? "completedAt" : "dueDate", { ascending: tab !== "done" }).order("id").range(page * 50, page * 50 + 49);
  if (error) throw new Error(`Could not load tasks: ${error.message}`);
  return {
    total: count ?? 0,
    rows: (data ?? []).map((t) => ({
      id: t.id, title: t.title, type: t.type, dueDate: t.dueDate, priority: t.priority, status: t.status, completedAt: t.completedAt,
      prospectId: t.prospectId, campaignId: t.campaignId,
      prospect: (one(t.prospect) as { businessName?: string } | null)?.businessName ?? null,
      campaign: (one(t.campaign) as { name?: string } | null)?.name ?? null,
      assignee: (one(t.assignee) as { fullName?: string } | null)?.fullName ?? null,
    })),
  };
}

/** Counts for the task tabs. */
export async function countProspectTasks(filters: { mine?: boolean; campaignId?: string }) {
  const me = await requireRead();
  const db = await supabaseServer();
  const today = new Date().toISOString().slice(0, 10);
  const base = () => {
    let q = db.from("prospect_task").select("id", { count: "exact", head: true });
    if (filters.mine) q = q.eq("assignedTo", me.id);
    if (filters.campaignId) q = q.eq("campaignId", filters.campaignId);
    return q;
  };
  const [overdue, todayN, upcoming] = await Promise.all([
    base().eq("status", "open").lt("dueDate", today),
    base().eq("status", "open").lte("dueDate", today),
    base().eq("status", "open").gt("dueDate", today),
  ]);
  return { overdue: overdue.count ?? 0, today: todayN.count ?? 0, upcoming: upcoming.count ?? 0 };
}

const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(["followup_email", "call_lead", "meeting_reminder", "general_reminder"]).default("general_reminder"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Due date: choose a date."),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  prospectId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  campaignId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  assignedTo: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
});

export async function createProspectTask(input: z.input<typeof taskSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const db = await supabaseServer();
  const { error } = await db.from("prospect_task").insert({ ...parsed.data, assignedTo: parsed.data.assignedTo ?? auth.user.id, createdById: auth.user.id });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}

export async function setProspectTaskDone(taskId: string, done: boolean): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const { error } = await db.from("prospect_task").update(done
    ? { status: "done", completedAt: new Date().toISOString(), completedById: auth.user.id }
    : { status: "open", completedAt: null, completedById: null }).eq("id", taskId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: undefined };
}
