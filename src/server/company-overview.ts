"use server";

import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, requireUser, can } from "@/lib/authz";

/**
 * The Company overview: the whole business on one screen, for the Super
 * Admin and CRM Admins. Every figure comes from company_overview() in the
 * database, which also feeds the Monday summary email, so the two agree.
 */

export interface CompanyOverview {
  period: { from: string; to: string; previousFrom: string; previousTo: string; today: string };
  current: Record<string, number>;
  previous: Record<string, number>;
  funnel: Record<string, number>;
  sales: {
    pipelineValue: number; openDeals: number; closingThisMonth: number; closingThisMonthValue: number; pastCloseDate: number;
    byStage: { stage: string; count: number; value: number }[];
    topDeals: { id: string; name: string; stage: string; value: number; closeDate: string | null }[];
  };
  delivery: {
    activeProjects: number; overdueTasks: number; byHealth: { GREEN: number; AMBER: number; RED: number };
    projects: { id: string; name: string; number: string; health: string | null; status: string; approvedHours: number | null; logged: number; completion: number | null; overdueTasks: number; margin: number }[];
    workload: { id: string; name: string; weekHours: number }[];
  };
  money: { outstanding: number; overdueCount: number; overdueValue: number; aging: { current: number; d1_30: number; d31_60: number; d61: number } };
  team: { id: string; name: string; touches: number; qualified: number; won: number; hours: number }[];
  attention: { approvals: number; casesBreached: number; contractsExpiring: number; staleLeads: number; overdueInvoices: number; dealsPastClose: number };
}

export async function getCompanyOverview(from: string, to: string): Promise<CompanyOverview> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) throw new Error("The Company overview is for administrators.");
  const db = await supabaseServer();
  const { data, error } = await db.rpc("company_overview", { p_from: from, p_to: to });
  if (error) throw new Error(`Could not load the overview: ${error.message}`);
  return data as CompanyOverview;
}

export interface OverviewExtras {
  cash: { overdueIn: number; dueIn: number; bills: number; commissions: number; expenses: number };
  trends: { month: string; invoiced: number; collected: number; newPipeline: number }[];
  health: { lastEmailOutcome: string | null; emailFailed7d: number; jobsFailed7d: number; signInsFailed7d: number };
  timesheets: { weekStart: string; people: { id: string; name: string; committed: number; logged: number; salesHours?: number; status: string | null }[] };
}

export async function getOverviewExtras(): Promise<OverviewExtras> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) throw new Error("The Company overview is for administrators.");
  const db = await supabaseServer();
  const { data, error } = await db.rpc("company_overview_extras");
  if (error) throw new Error(`Could not load the overview: ${error.message}`);
  const extras = data as OverviewExtras;
  // Sales time in the same week, so people whose work is not on projects do not read as idle.
  const weekEnd = new Date(new Date(`${extras.timesheets.weekStart}T00:00:00Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const { data: sales } = await db.from("time_log").select("userId, hours").not("salesEntityId", "is", null)
    .gte("workDate", extras.timesheets.weekStart).lt("workDate", weekEnd);
  const byUser = new Map<string, number>();
  for (const r of (sales ?? []) as { userId: string; hours: number }[]) byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + Number(r.hours));
  for (const p of extras.timesheets.people) p.salesHours = byUser.get(p.id) ?? 0;
  return extras;
}
