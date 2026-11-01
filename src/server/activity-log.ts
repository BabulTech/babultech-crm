"use server";

import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase";
import type { ActionResult } from "./partners";

export interface ActivityFilters {
  q?: string;
  category?: string;
  outcome?: string;
  actor?: string;
  from?: string;
  to?: string;
}

export interface ActivityRow {
  id: string;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  summary: string;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  detail: Record<string, unknown> | null;
}

/** Read as the viewer: RLS gives admins everything and others their own actions. */
export async function listActivity(filters: ActivityFilters, page = 1, pageSize = 100): Promise<{ rows: ActivityRow[]; total: number }> {
  await requireUser();
  const db = await supabaseServer();
  let query = db
    .from("activity_event")
    .select("id, occurredAt, category, action, outcome, summary, actorName, entityType, entityId, detail", { count: "exact" });
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.outcome) query = query.eq("outcome", filters.outcome);
  if (filters.actor) query = query.ilike("actorName", `%${filters.actor}%`);
  if (filters.q) query = query.ilike("summary", `%${filters.q}%`);
  // Dates are chosen in Pakistan time.
  if (filters.from) query = query.gte("occurredAt", `${filters.from}T00:00:00+05:00`);
  if (filters.to) query = query.lte("occurredAt", `${filters.to}T23:59:59+05:00`);
  const start = (page - 1) * pageSize;
  const { data, count, error } = await query.order("occurredAt", { ascending: false }).range(start, start + pageSize - 1);
  if (error) throw new Error(`Could not load the activity log: ${error.message}`);
  return { rows: (data ?? []) as ActivityRow[], total: count ?? 0 };
}

/** Failing now means the most recent email attempt failed. Admins only. */
export async function getEmailHealth(): Promise<{ failing: boolean; failures: number; error: string | null; since: string | null }> {
  const healthy = { failing: false, failures: 0, error: null, since: null };
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return healthy;
  const db = supabaseAdmin();
  const { data: lastSent } = await db.from("activity_event").select("occurredAt").eq("category", "EMAIL").eq("outcome", "OK")
    .order("occurredAt", { ascending: false }).limit(1).maybeSingle();
  let failed = db.from("activity_event").select("occurredAt, detail", { count: "exact" }).eq("category", "EMAIL").eq("outcome", "FAILED");
  if (lastSent) failed = failed.gt("occurredAt", lastSent.occurredAt);
  const { data, count } = await failed.order("occurredAt", { ascending: false }).limit(1);
  if (!count) return healthy;
  return {
    failing: true,
    failures: count,
    error: ((data?.[0]?.detail as { error?: string } | null)?.error) ?? null,
    since: lastSent?.occurredAt ?? null,
  };
}

export async function retryFailedEmails(): Promise<ActionResult<{ count: number }>> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return { ok: false, error: "Only an administrator can do this." };
  const { data, error } = await supabaseAdmin().rpc("retry_failed_notification_emails");
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: { count: (data as number) ?? 0 } };
}
