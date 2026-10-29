"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase";
import { authorize, requireUser } from "@/lib/authz";
import { isReservedAddress } from "@/lib/notification-mailer";
import type { ActionResult } from "./partners";

/**
 * Weekly timesheets: each employee submits their week (Monday to Sunday) with
 * a reason when it is short of their committed hours, and a CRM Admin or Super
 * Admin approves it or returns it with remarks. A CRM Admin's week goes to a
 * Super Admin only; Super Admins keep no timesheet. Reminders are sent by the
 * database (timesheet_reminders) at 9 pm and 9 am Pakistan time.
 */

type Rank = "SUPER" | "CRM_ADMIN" | "EMPLOYEE";
type SheetStatus = "SUBMITTED" | "APPROVED" | "RETURNED";

const isWeekStart = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).getUTCDay() === 1;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const round1 = (n: number) => Math.round(n * 10) / 10;

async function rankOf(userId: string): Promise<Rank> {
  const { data } = await supabaseAdmin().rpc("timesheet_rank", { p_user: userId });
  return (data as Rank | null) ?? "EMPLOYEE";
}

/** Whether `approver` may approve the timesheet of someone of `subject` rank. */
function mayApprove(approver: Rank, subject: Rank): boolean {
  if (subject === "SUPER") return false;
  if (subject === "CRM_ADMIN") return approver === "SUPER";
  return approver === "SUPER" || approver === "CRM_ADMIN";
}

async function loggedHours(userId: string, weekStart: string): Promise<number> {
  const { data } = await supabaseAdmin().from("time_log").select("hours").eq("userId", userId).gte("workDate", weekStart).lt("workDate", addDays(weekStart, 7));
  return round1((data ?? []).reduce((s, r) => s + Number(r.hours ?? 0), 0));
}

/** This person's week: what they owe, what they have logged, and where it stands. */
export async function getMyTimesheetWeek(weekStart: string) {
  const me = await requireUser();
  if (!isWeekStart(weekStart)) return null;
  const admin = supabaseAdmin();
  const [rank, committed, logged, sheet] = await Promise.all([
    rankOf(me.id),
    admin.rpc("timesheet_committed_hours", { p_user: me.id }).then((r) => Number(r.data ?? 40)),
    loggedHours(me.id, weekStart),
    admin.from("weekly_timesheet").select("status, \"shortfallReason\", \"submittedAt\", remarks, \"decidedAt\", decidedBy:app_user!weekly_timesheet_decidedById_fkey ( \"fullName\" )").eq("userId", me.id).eq("weekStart", weekStart).maybeSingle().then((r) => r.data),
  ]);
  const decidedBy = sheet ? (Array.isArray(sheet.decidedBy) ? sheet.decidedBy[0] : sheet.decidedBy) as { fullName?: string } | null : null;
  return {
    rank,
    keepsTimesheet: rank !== "SUPER",
    committed,
    logged,
    status: (sheet?.status as SheetStatus | undefined) ?? null,
    shortfallReason: (sheet?.shortfallReason as string | null) ?? null,
    remarks: (sheet?.remarks as string | null) ?? null,
    decidedBy: decidedBy?.fullName ?? null,
    decidedAt: (sheet?.decidedAt as string | null) ?? null,
  };
}

/** Submits the week: every entry in it, and the week itself with any shortfall reason. */
export async function submitTimesheetWeek(weekStart: string, shortfallReason: string): Promise<ActionResult<{ count: number }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const me = auth.user;
  if (!isWeekStart(weekStart)) return { ok: false, error: "Choose a week starting on a Monday." };
  const rank = await rankOf(me.id);
  if (rank === "SUPER") return { ok: false, error: "Super Admins do not submit timesheets." };
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  if (weekStart > today) return { ok: false, error: "That week has not started yet." };

  const admin = supabaseAdmin();
  const { data: existing } = await admin.from("weekly_timesheet").select("status").eq("userId", me.id).eq("weekStart", weekStart).maybeSingle();
  if (existing?.status === "APPROVED") return { ok: false, error: "This week is already approved." };
  if (existing?.status === "SUBMITTED") return { ok: false, error: "This week is already submitted and waiting for approval." };

  const committed = Number((await admin.rpc("timesheet_committed_hours", { p_user: me.id })).data ?? 40);
  const logged = await loggedHours(me.id, weekStart);
  const reason = shortfallReason.trim();
  if (logged < committed && reason.length < 3) {
    return { ok: false, error: `You have logged ${logged} of your ${committed} hours. Say why the week is short before submitting it.` };
  }

  // The entries, as the person (their own rows), then the week.
  const { data: rows, error } = await (await supabaseServer())
    .from("time_log")
    .update({ approvalStatus: "SUBMITTED", updatedAt: new Date().toISOString() })
    .eq("userId", me.id)
    .gte("workDate", weekStart)
    .lt("workDate", addDays(weekStart, 7))
    .in("approvalStatus", ["DRAFT", "REJECTED"])
    .select("id");
  if (error) return { ok: false, error: error.message };

  const now = new Date().toISOString();
  const { data: sheet, error: sheetError } = await admin.from("weekly_timesheet").upsert({
    userId: me.id, weekStart, status: "SUBMITTED", committedHours: committed, loggedHours: logged,
    shortfallReason: logged < committed ? reason : null, submittedAt: now, decidedById: null, decidedAt: null, remarks: null, updatedAt: now,
  }, { onConflict: "userId,weekStart" }).select("id").single();
  if (sheetError) return { ok: false, error: sheetError.message };

  // Tell everyone who may approve it. A test login (a reserved address) only
  // ever reaches other test logins, so trying the system never pings real people.
  const { data: approvers } = await admin.from("app_user").select("id, email").eq("status", "ACTIVE").is("deletedAt", null).neq("id", me.id);
  const testing = isReservedAddress(me.email ?? "");
  const ranks = await Promise.all((approvers ?? []).filter((a) => !testing || isReservedAddress(String(a.email ?? ""))).map(async (a) => ({ id: a.id as string, rank: await rankOf(a.id as string) })));
  const title = `${me.fullName}'s timesheet needs approval`;
  const body = `Week of ${weekStart}: ${logged} of ${committed} hours${logged < committed ? `. Reason: ${reason}` : ""}.`;
  await Promise.all(ranks.filter((a) => mayApprove(a.rank, rank)).map((a) =>
    admin.rpc("notify_user", { p_user: a.id, p_kind: "APPROVAL_REQUESTED", p_title: title, p_body: body, p_link: `/timesheets/approvals?week=${weekStart}`, p_entity_type: "WeeklyTimesheet", p_entity_id: sheet.id, p_dedupe: `timesheet-submitted-${sheet.id}-${now}` })));

  revalidatePath("/timesheets");
  revalidatePath("/timesheets/approvals");
  return { ok: true, data: { count: (rows ?? []).length } };
}

export interface TeamWeekRow {
  userId: string;
  fullName: string;
  rank: Rank;
  committed: number;
  logged: number;
  status: SheetStatus | "NOT_SUBMITTED";
  sheetId: string | null;
  shortfallReason: string | null;
  remarks: string | null;
  decidedBy: string | null;
  submittedAt: string | null;
  canDecide: boolean;
  trend: { weekStart: string; logged: number }[];
}

/**
 * Everyone who keeps a timesheet, for one week: committed, logged and status,
 * and whether the person looking may approve it. CRM Admins and Super Admins only.
 */
export async function getTeamTimesheets(weekStart: string): Promise<{ myRank: Rank; rows: TeamWeekRow[] } | null> {
  const me = await requireUser();
  const myRank = await rankOf(me.id);
  if (myRank === "EMPLOYEE" || !isWeekStart(weekStart)) return null;
  const admin = supabaseAdmin();
  const from = addDays(weekStart, -21);
  const [people, sheets, logs] = await Promise.all([
    admin.rpc("timesheet_people"),
    admin.from("weekly_timesheet").select("id, \"userId\", status, \"shortfallReason\", remarks, \"submittedAt\", decidedBy:app_user!weekly_timesheet_decidedById_fkey ( \"fullName\" )").eq("weekStart", weekStart),
    admin.from("time_log").select("\"userId\", \"workDate\", hours").gte("workDate", from).lt("workDate", addDays(weekStart, 7)),
  ]);
  const sheetBy = new Map((sheets.data ?? []).map((s) => [s.userId as string, s]));
  const hours = new Map<string, number>();
  for (const l of logs.data ?? []) {
    const d = new Date(`${l.workDate}T00:00:00Z`);
    const wk = addDays(String(l.workDate).slice(0, 10), -((d.getUTCDay() + 6) % 7));
    const key = `${l.userId}|${wk}`;
    hours.set(key, (hours.get(key) ?? 0) + Number(l.hours ?? 0));
  }
  const weeks = [3, 2, 1, 0].map((n) => addDays(weekStart, -7 * n));
  const rows = ((people.data ?? []) as { userId: string; fullName: string; rank: Rank; committed: number }[]).map((p) => {
    const s = sheetBy.get(p.userId);
    const decidedBy = s ? (Array.isArray(s.decidedBy) ? s.decidedBy[0] : s.decidedBy) as { fullName?: string } | null : null;
    return {
      userId: p.userId,
      fullName: p.fullName,
      rank: p.rank,
      committed: Number(p.committed),
      logged: round1(hours.get(`${p.userId}|${weekStart}`) ?? 0),
      status: ((s?.status as SheetStatus | undefined) ?? "NOT_SUBMITTED") as TeamWeekRow["status"],
      sheetId: (s?.id as string | undefined) ?? null,
      shortfallReason: (s?.shortfallReason as string | null) ?? null,
      remarks: (s?.remarks as string | null) ?? null,
      decidedBy: decidedBy?.fullName ?? null,
      submittedAt: (s?.submittedAt as string | null) ?? null,
      canDecide: p.userId !== me.id && mayApprove(myRank, p.rank),
      trend: weeks.map((w) => ({ weekStart: w, logged: round1(hours.get(`${p.userId}|${w}`) ?? 0) })),
    };
  }).sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { myRank, rows };
}

/** One person's entries for a week, for the approver to look through. */
export async function getTimesheetEntries(userId: string, weekStart: string) {
  const me = await requireUser();
  const myRank = await rankOf(me.id);
  if (myRank === "EMPLOYEE" || !isWeekStart(weekStart)) return [];
  const { data } = await supabaseAdmin()
    .from("time_log")
    .select("id, \"workDate\", hours, description, billable, \"approvalStatus\", project ( name ), case:support_case ( \"caseNumber\" )")
    .eq("userId", userId).gte("workDate", weekStart).lt("workDate", addDays(weekStart, 7)).order("workDate");
  return (data ?? []).map((e) => ({
    id: e.id as string, workDate: String(e.workDate), hours: Number(e.hours), description: (e.description as string | null) ?? "",
    on: ((Array.isArray(e.project) ? e.project[0] : e.project) as { name?: string } | null)?.name
      ?? ((Array.isArray(e.case) ? e.case[0] : e.case) as { caseNumber?: string } | null)?.caseNumber ?? "Internal",
    status: String(e.approvalStatus),
  }));
}

/** Approves a submitted week, or returns it with remarks (required when returning). */
export async function decideTimesheet(sheetId: string, decision: "APPROVE" | "RETURN", remarks: string): Promise<ActionResult> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const me = auth.user;
  const admin = supabaseAdmin();
  const { data: sheet } = await admin.from("weekly_timesheet").select("id, \"userId\", \"weekStart\", status, \"loggedHours\", \"committedHours\"").eq("id", sheetId).maybeSingle();
  if (!sheet) return { ok: false, error: "That timesheet could not be found." };
  if (sheet.userId === me.id) return { ok: false, error: "You cannot approve your own timesheet." };
  const [myRank, theirRank] = await Promise.all([rankOf(me.id), rankOf(sheet.userId as string)]);
  if (!mayApprove(myRank, theirRank)) {
    return { ok: false, error: theirRank === "CRM_ADMIN" ? "A CRM Admin's timesheet is approved by a Super Admin." : "Only CRM Admins and Super Admins approve timesheets." };
  }
  if (sheet.status !== "SUBMITTED") return { ok: false, error: "Only a submitted timesheet can be approved or returned." };
  const note = remarks.trim();
  if (decision === "RETURN" && note.length < 3) return { ok: false, error: "Say what needs fixing, for example \"Time is not complete\"." };

  const weekStart = String(sheet.weekStart);
  const { data: entries } = await admin.from("time_log").select("id").eq("userId", sheet.userId).gte("workDate", weekStart).lt("workDate", addDays(weekStart, 7)).eq("approvalStatus", "SUBMITTED");
  const ids = (entries ?? []).map((e) => e.id as string);
  if (ids.length) {
    const { error } = await admin.rpc("transition_time_logs", { p_ids: ids, p_from_statuses: ["SUBMITTED"], p_to_status: decision === "APPROVE" ? "APPROVED" : "REJECTED", p_actor_id: me.id, p_set_approver: true });
    if (error) return { ok: false, error: error.message };
  }
  const now = new Date().toISOString();
  const { error } = await admin.from("weekly_timesheet").update({ status: decision === "APPROVE" ? "APPROVED" : "RETURNED", decidedById: me.id, decidedAt: now, remarks: note || null, updatedAt: now }).eq("id", sheetId).eq("status", "SUBMITTED");
  if (error) return { ok: false, error: error.message };

  await admin.rpc("notify_user", {
    p_user: sheet.userId,
    p_kind: "APPROVAL_DECIDED",
    p_title: decision === "APPROVE" ? `Your timesheet for the week of ${weekStart} is approved` : `Your timesheet for the week of ${weekStart} was returned`,
    p_body: `${decision === "APPROVE" ? "Approved" : "Returned"} by ${me.fullName}${note ? `: ${note}` : "."}${decision === "RETURN" ? " Fix it and submit the week again." : ""}`,
    p_link: `/timesheets?week=${weekStart}`,
    p_entity_type: "WeeklyTimesheet",
    p_entity_id: sheetId,
    p_dedupe: `timesheet-decided-${sheetId}-${now}`,
  });
  revalidatePath("/timesheets/approvals");
  revalidatePath("/timesheets");
  return { ok: true, data: undefined };
}
