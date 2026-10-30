"use server";

import { TIME_PUBLIC_COLUMNS, withRateSnapshots } from "@/lib/rate-snapshots";
import { describeInvalid } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import Decimal from "decimal.js";
import { toDecimal, one } from "@/lib/decimal";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { createRecord, updateRecord } from "@/lib/db";
import { PERMISSIONS, authorize, requirePermission, requireUser } from "@/lib/authz";
import { hoursBetween, normaliseClock } from "@/lib/work-hours";
import { looksLikeHtml, sanitizeRichText } from "@/lib/rich-text";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionResult } from "./partners";

/** The slice of the Supabase client the billable guard needs. */
type Db = Pick<SupabaseClient, "from">;

/**
 * Timesheets (spec §10.4 Time Log).
 *
 * The workflow is the standard PSA one: DRAFT → SUBMITTED → APPROVED (or
 * REJECTED, which returns it to the author as a draft). Rates are captured on
 * the entry at submission time from the project membership, so re-rating
 * someone next year cannot rewrite what last year's work cost.
 *
 * Approval is deliberately someone else's job — `approveTimeLogs` requires the
 * `time:approve` permission and refuses your own entries.
 */

const HOURS_PER_DAY_CEILING = 24;

/**
 * Internal work is never billable, whatever the form sent.
 *
 * An internal project has no customer — createProject clears its account,
 * opportunity and contract for that reason — so time marked billable against
 * one describes an invoice that can never be raised. Those hours feed
 * `billableValue`, utilisation and every margin figure, which is how a company
 * ends up reading its own overhead back as revenue.
 *
 * Enforced on the server rather than only in the form: the checkbox is hidden
 * for internal work, but a stale tab, a direct action call, or a project
 * converted from customer to internal after the fact would all still arrive
 * with billable true.
 */
async function isBillableProject(
  db: Db,
  projectId: string,
  requested: boolean,
): Promise<boolean> {
  if (!requested) return false;

  const { data: project } = await db
    .from("project")
    .select("projectType")
    .eq("id", projectId)
    .maybeSingle();

  return project?.projectType === "INTERNAL" ? false : requested;
}

/**
 * Clock times are optional and hours are not.
 *
 * `hours` is what approval, invoicing, cost and utilisation all read, so it is
 * always stored. Start and end record *when* the work happened, which is what a
 * customer asks when they query a bill — but demanding them would push people to
 * invent times they never wrote down, and invented precision is worse than an
 * honest total.
 *
 * `hours` is therefore optional in the schema and resolved afterwards: derived
 * from the times when both are given, taken as typed when they are not. One of
 * the two has to be present, which the refinement below enforces.
 */
const timeLogSchema = z
  .object({
    projectId: z.string().uuid().optional().nullable(),
    projectTaskId: z.string().uuid().optional().nullable(),
    caseId: z.string().uuid().optional().nullable(),
    workDate: z.coerce.date(),
    hours: z.coerce.number().positive().max(HOURS_PER_DAY_CEILING).optional().nullable(),
    startTime: z.string().optional().nullable(),
    endTime: z.string().optional().nullable(),
    // Rich text from the editor, cleaned before it is stored. An editor left
    // empty posts "<p></p>", which sanitizeRichText turns into null.
    description: z
      .string()
      .max(40000, "The details are too long. Keep them under about 20,000 characters.")
      .transform((v) => sanitizeRichText(v) ?? "")
      .refine((v) => v.length > 0, "Say what you worked on."),
    billable: z.boolean().default(false),
    /** Move the task to COMPLETED once the time is recorded. */
    completeTask: z.boolean().default(false),
  })
  .refine(
    (v) => Boolean(v.hours) || hoursBetween(v.startTime, v.endTime) !== null,
    {
      message: "Give either a start and end time, or a number of hours.",
      path: ["hours"],
    },
  );

/** Monday of the week containing `date`. Timesheets are Monday–Sunday. */
export async function startOfWeek(date: Date): Promise<Date> {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

function weekBounds(weekStart: Date): { from: Date; to: Date } {
  const from = new Date(weekStart);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

export async function logTime(
  input: z.infer<typeof timeLogSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize();
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = timeLogSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  // Mirrors the database's time_log_context_check.
  if (!data.projectId && !data.projectTaskId && !data.caseId) {
    return {
      ok: false,
      error: "Time has to be logged against a project, a task or a support case.",
      fieldErrors: { projectId: ["Pick something to book this against."] },
    };
  }

  try {
    const db = await supabaseServer();

    // A task implies its project, even if the form only sent the task.
    let projectId = data.projectId ?? null;
    if (data.projectTaskId) {
      const { data: task } = await db
        .from("project_task")
        .select("projectId, billable")
        .eq("id", data.projectTaskId)
        .maybeSingle();

      if (!task) return { ok: false, error: "That task no longer exists." };
      projectId = task.projectId;
    }

    // Derived, never trusted from the form: if both clock times are present
    // they decide the duration, so the stored hours can never contradict the
    // times shown beside them.
    const derived = hoursBetween(data.startTime, data.endTime);
    const hours = derived ?? data.hours;

    if (!hours) {
      return {
        ok: false,
        error: "Give either a start and end time, or a number of hours.",
        fieldErrors: { hours: ["Required unless you enter start and end times."] },
      };
    }

    if (hours > HOURS_PER_DAY_CEILING) {
      return {
        ok: false,
        error: `That works out at ${hours} hours. Check the times - the most that can be logged against one date is ${HOURS_PER_DAY_CEILING}.`,
        fieldErrors: { endTime: ["Longer than a day."] },
      };
    }

    // Internal work has no customer, so its time can never be billed whatever
    // the form sent. This is the figure that feeds billableValue, utilisation
    // and every margin number, so letting a stale tab mark internal time
    // billable is how a company reads its own overhead back as revenue.
    const billable = projectId
      ? await isBillableProject(db, projectId, data.billable)
      : data.billable;

    const base = {
      userId: user.id,
      caseId: data.caseId ?? null,
      workDate: data.workDate.toISOString().slice(0, 10),
      hours,
      // Padded to match what a TIME column returns, so a value read back
      // compares equal to the one that was written.
      startTime: normaliseClock(data.startTime),
      endTime: normaliseClock(data.endTime),
      description: data.description,
      billable,
      approvalStatus: "DRAFT",
    };

    let created: { id: string; projectId?: string | null };

    if (projectId) {
      // The rate snapshot comes from the project membership, so a later rate
      // change cannot rewrite what already-logged time was worth.
      const { data: member } = await db
        .from("project_member")
        .select("active")
        .eq("projectId", projectId)
        .eq("userId", user.id)
        .maybeSingle();

      if (!member || !member.active) {
        return {
          ok: false,
          error:
            "You are not an active member of that project, so you cannot book time to it.",
        };
      }

      created = await createRecord<{ id: string; projectId: string | null }>("time_log", {
        ...base,
        projectId,
        projectTaskId: data.projectTaskId ?? null,

      });
    } else {
      // The database snapshots standing rates for support-case time.
      created = await createRecord<{ id: string; projectId: string | null }>("time_log", {
        ...base,

      });
    }

    // Completing the task is a second step on purpose: the time is the record
    // that matters and is already written, so a failed status update (a task
    // deleted underneath, say) must not take the hours with it.
    if (data.completeTask && data.projectTaskId && projectId) {
      await db
        .from("project_task")
        .update({ status: "COMPLETED", updatedAt: new Date().toISOString() })
        .eq("id", data.projectTaskId)
        .eq("projectId", projectId);
    }

    revalidatePath("/timesheets");
    if (created.projectId) revalidatePath(`/projects/${created.projectId}`);
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not log the time." };
  }
}

export async function updateTimeLog(
  id: string,
  input: z.infer<typeof timeLogSchema>,
): Promise<ActionResult> {
  const _auth = await authorize();
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = timeLogSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const db = await supabaseServer();

    const { data: existing } = await db
      .from("time_log")
      .select("userId, approvalStatus, projectId")
      .eq("id", id)
      .maybeSingle();

    if (!existing) return { ok: false, error: "That entry no longer exists." };
    if (existing.userId !== user.id) {
      return { ok: false, error: "You can only edit your own time entries." };
    }
    if (existing.approvalStatus === "APPROVED") {
      return { ok: false, error: "Approved time is locked. Ask your approver to reject it first." };
    }

    // Editing resets the entry to DRAFT, so a changed entry cannot keep a
    // stale approval.
    const { error } = await db
      .from("time_log")
      .update({
        workDate: parsed.data.workDate.toISOString().slice(0, 10),
        // Same derivation as logTime: clock times win when both are given, so
        // an edit cannot leave the hours disagreeing with the times beside them.
        hours: hoursBetween(parsed.data.startTime, parsed.data.endTime) ?? parsed.data.hours,
        startTime: normaliseClock(parsed.data.startTime),
        endTime: normaliseClock(parsed.data.endTime),
        description: parsed.data.description,
        // Same rule as logTime: an edit cannot make internal time billable.
        billable: existing.projectId
          ? await isBillableProject(db, existing.projectId, parsed.data.billable)
          : parsed.data.billable,
        approvalStatus: "DRAFT",
        updatedAt: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw new Error(error.message);

    revalidatePath("/timesheets");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the entry." };
  }
}

export async function deleteTimeLog(id: string): Promise<ActionResult> {
  const _auth = await authorize();
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: existing } = await db
      .from("time_log")
      .select("userId, approvalStatus, invoiceLineId")
      .eq("id", id)
      .maybeSingle();

    if (!existing) return { ok: false, error: "That entry no longer exists." };
    if (existing.userId !== user.id) {
      return { ok: false, error: "You can only delete your own time entries." };
    }
    if (existing.approvalStatus === "APPROVED") {
      return { ok: false, error: "Approved time cannot be deleted - it is part of the project's cost record." };
    }
    if (existing.invoiceLineId) {
      return { ok: false, error: "This time has already been invoiced." };
    }

    const { error } = await db.from("time_log").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/timesheets");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not delete the entry." };
  }
}

/** Submits a whole week for approval. */
export async function submitWeek(weekStartISO: string): Promise<ActionResult<{ count: number }>> {
  const _auth = await authorize();
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;
  const { from, to } = weekBounds(new Date(weekStartISO));

  try {
    const db = await supabaseServer();

    const { data: rows, error } = await db
      .from("time_log")
      .update({ approvalStatus: "SUBMITTED", updatedAt: new Date().toISOString() })
      .eq("userId", user.id)
      .gte("workDate", from.toISOString().slice(0, 10))
      .lt("workDate", to.toISOString().slice(0, 10))
      .in("approvalStatus", ["DRAFT", "REJECTED"])
      .select("id");

    if (error) throw new Error(error.message);

    const result = { count: (rows ?? []).length };

    if (result.count === 0) {
      return { ok: false, error: "There is nothing to submit for that week." };
    }

    revalidatePath("/timesheets");
    revalidatePath("/timesheets/approvals");
    return { ok: true, data: { count: result.count } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not submit the week." };
  }
}

export async function approveTimeLogs(ids: string[]): Promise<ActionResult<{ count: number }>> {
  const _auth = await authorize(PERMISSIONS.TIME_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };

  try {
    const db = await supabaseServer();

    const { data: logs } = await db
      .from("time_log")
      .select("id, userId, approvalStatus, projectId")
      .in("id", ids);

    const entries = logs ?? [];

    if (entries.some((l) => l.userId === user.id)) {
      return { ok: false, error: "You cannot approve your own time." };
    }
    if (entries.some((l) => l.approvalStatus !== "SUBMITTED")) {
      return { ok: false, error: "Only submitted entries can be approved." };
    }

    // Status change, approver stamp and one audit row per entry, atomically.
    // The status filter is inside the function, so a retry cannot overwrite the
    // original approver.
    const { error } = await db.rpc("transition_time_logs", {
      p_ids: ids,
      p_from_statuses: ["SUBMITTED"],
      p_to_status: "APPROVED",
      p_actor_id: user.id,
      p_set_approver: true,
    });

    if (error) throw new Error(error.message);

    revalidatePath("/timesheets/approvals");
    revalidatePath("/timesheets");
    for (const p of new Set(entries.map((l) => l.projectId).filter(Boolean))) {
      revalidatePath(`/projects/${p}`);
    }
    return { ok: true, data: { count: entries.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not approve the time." };
  }
}

export async function rejectTimeLogs(ids: string[], reason: string): Promise<ActionResult<{ count: number }>> {
  const _auth = await authorize(PERMISSIONS.TIME_APPROVE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };
  if (!reason.trim()) return { ok: false, error: "Give a reason so the person knows what to fix." };

  try {
    const db = await supabaseServer();

    const { data: fetched } = await db
      .from("time_log")
      .select("id, description, approvalStatus")
      .in("id", ids);

    const logs = fetched ?? [];

    if (logs.some((l) => l.approvalStatus !== "SUBMITTED")) {
      return { ok: false, error: "Only submitted entries can be rejected." };
    }

    // Status + approver stamp + audit, atomically.
    const { error } = await db.rpc("transition_time_logs", {
      p_ids: ids,
      p_from_statuses: ["SUBMITTED"],
      p_to_status: "REJECTED",
      p_actor_id: user.id,
      p_set_approver: true,
    });

    if (error) throw new Error(error.message);

    // The reason is appended per entry, so each description differs — done
    // after the transition rather than inside it, since a failure here leaves
    // the rejection itself intact and only loses the appended note.
    const stampedAt = new Date().toISOString();
    const reasons = await Promise.all(logs.map((log) => db.from("time_log")
      .update({
        // Rich-text entries get the note as a paragraph, plain ones as a line.
        description: looksLikeHtml(log.description)
          ? sanitizeRichText(`${log.description}<p><em>[Rejected by ${user.fullName}: ${reason.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;")}]</em></p>`) ?? log.description
          : `${log.description}\n\n[Rejected by ${user.fullName}: ${reason.trim()}]`,
        updatedAt: stampedAt,
      }).eq("id", log.id).select("id")));
    if (reasons.some((result) => result.error || result.data?.length !== 1)) {
      return { ok: false, error: "Time was rejected, but its review reason could not be saved." };
    }

    revalidatePath("/timesheets/approvals");
    revalidatePath("/timesheets");
    return { ok: true, data: { count: logs.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reject the time." };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getMyWeek(weekStartISO: string) {
  const user = await requireUser();
  const { from, to } = weekBounds(new Date(weekStartISO));

  const db = await supabaseServer();

  const { data, error } = await db
    .from("time_log")
    .select(
      `${TIME_PUBLIC_COLUMNS},
       project ( id, name, projectNumber ),
       projectTask:project_task ( id, name ),
       case:support_case ( id, caseNumber, subject )`,
    )
    .eq("userId", user.id)
    .gte("workDate", from.toISOString().slice(0, 10))
    .lt("workDate", to.toISOString().slice(0, 10))
    .order("workDate")
    .order("createdAt");

  if (error) throw new Error(`Could not load the week: ${error.message}`);

  const entries = (data ?? []).map((e) => ({
    ...e,
    project: one(e.project as never),
    projectTask: one(e.projectTask as never),
    case: one(e.case as never),
  }));

  return { entries, from, to };
}

/** What the current user can book time against. */
export async function getTimeEntryOptions() {
  const user = await requireUser();

  const db = await supabaseServer();

  const [membershipsRes, casesRes] = await Promise.all([
    db
      .from("project_member")
      .select(
        `project!inner (
           id, name, projectNumber, projectType, status, deletedAt,
           tasks:project_task ( id, name, billable, assignedUserId, status, sortOrder )
         )`,
      )
      .eq("userId", user.id)
      .eq("active", true)
      .is("project.deletedAt", null)
      .in("project.status", ["PLANNING", "ACTIVE", "AT_RISK"])
      .order("createdAt", { ascending: false }),
    db
      .from("support_case")
      .select("id, caseNumber, subject")
      .is("deletedAt", null)
      .eq("ownerUserId", user.id)
      .not("status", "in", '("CLOSED","CANCELLED")')
      .order("createdAt", { ascending: false }),
  ]);

  // PostgREST returns embedded tasks unfiltered and unordered, so the
  // open-task filter and sort order are applied here.
  const projects = (membershipsRes.data ?? []).map((m) => {
    const project = one(m.project as never) as unknown as Record<string, unknown>;
    const tasks = ((project?.tasks ?? []) as Record<string, unknown>[])
      .filter((t) => !["COMPLETED", "CANCELLED"].includes(String(t.status)))
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
    return { ...project, tasks };
  });

  return { projects, cases: casesRes.data ?? [] };
}

export async function getPendingApprovals() {
  const user = await requirePermission(PERMISSIONS.TIME_APPROVE);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("time_log")
    .select(
      `${TIME_PUBLIC_COLUMNS},
       user:app_user!time_log_userId_fkey ( id, fullName ),
       project ( id, name, projectNumber ),
       projectTask:project_task ( id, name ),
       case:support_case ( id, caseNumber )`,
    )
    .eq("approvalStatus", "SUBMITTED")
    .neq("userId", user.id)
    .order("workDate");

  if (error) throw new Error(`Could not load approvals: ${error.message}`);

  return (data ?? []).map((e) => ({
    ...e,
    user: one(e.user as never),
    project: one(e.project as never),
    projectTask: one(e.projectTask as never),
    case: one(e.case as never),
  }));
}

/**
 * Resource utilisation: what each person is booked for versus what they have
 * actually logged, over a window. `allocationPercent` on a project membership
 * is a claim on their week; logged hours are the reality. The gap between the
 * two is the number a delivery manager actually needs.
 */
export async function getUtilisation(weeks = 4) {
  await requirePermission(PERMISSIONS.PROJECT_RATES_READ);
  // time:approve, not project:read. This report lists every colleague's cost
  // rate and utilisation, which is a staffing and margin view for whoever books
  // the work — and the page that renders it already required time:approve, so
  // the weaker check here was a way around its own screen's gate.
  await requirePermission(PERMISSIONS.TIME_APPROVE);

  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setDate(from.getDate() - weeks * 7);

  const STANDARD_WEEKLY_HOURS = 40;
  const capacityHours = toDecimal(STANDARD_WEEKLY_HOURS * weeks);

  const db = await supabaseServer();

  const [usersRes, membershipsRes, logsRes] = await Promise.all([
    // Service role, because costRate and defaultBillingRate are revoked from
    // the authenticated role. The permission check above is what limits who
    // reaches this line — the client choice only decides whether the columns
    // come back at all.
    supabaseAdmin()
      .from("app_user")
      .select(
        `id, fullName, jobTitle, costRate, defaultBillingRate,
         department:app_user_departmentId_fkey ( id, name )`,
      )
      .eq("status", "ACTIVE")
      .is("deletedAt", null)
      .order("fullName"),
    db
      .from("project_member")
      .select(
        `userId, allocationPercent,
         project!inner ( id, name, projectNumber, status, deletedAt )`,
      )
      .eq("active", true)
      .is("project.deletedAt", null)
      .in("project.status", ["PLANNING", "ACTIVE", "AT_RISK"]),
    // PostgREST has no groupBy, so the raw hours are fetched and summed below.
    db
      .from("time_log")
      .select("userId, billable, hours")
      .gte("workDate", from.toISOString().slice(0, 10))
      .lte("workDate", to.toISOString().slice(0, 10))
      .neq("approvalStatus", "REJECTED"),
  ]);

  const users = (usersRes.data ?? []).map((u) => ({
    ...u,
    department: one(u.department as never) as unknown as { id: string; name: string } | null,
  }));

  const memberships = (membershipsRes.data ?? []).map((m) => ({
    ...m,
    project: one(m.project as never),
  }));

  // Bucket by (userId, billable), matching the shape the report below reads.
  const grouped = new Map<string, { userId: string; billable: boolean; _sum: { hours: Decimal } }>();
  for (const l of logsRes.data ?? []) {
    const key = `${l.userId}|${l.billable}`;
    const acc =
      grouped.get(key) ??
      { userId: l.userId as string, billable: Boolean(l.billable), _sum: { hours: toDecimal(0) } };
    acc._sum.hours = acc._sum.hours.plus(toDecimal(l.hours));
    grouped.set(key, acc);
  }
  const logs = [...grouped.values()];

  return {
    from,
    to,
    weeks,
    capacityHours,
    rows: users.map((u) => {
      const theirProjects = memberships.filter((m) => m.userId === u.id);
      const allocatedPercent = theirProjects.reduce(
        (s, m) => s + Number(m.allocationPercent ?? 0),
        0,
      );
      const billable = logs.find((l) => l.userId === u.id && l.billable)?._sum.hours ?? toDecimal(0);
      const nonBillable = logs.find((l) => l.userId === u.id && !l.billable)?._sum.hours ?? toDecimal(0);
      const logged = toDecimal(billable).plus(nonBillable);

      return {
        user: u,
        projects: theirProjects.map((m) => {
          const proj = (m.project ?? {}) as { id?: string; name?: string; projectNumber?: string };
          return {
            id: proj.id ?? '',
            name: proj.name ?? '',
            projectNumber: proj.projectNumber ?? '',
            allocationPercent: m.allocationPercent,
          };
        }),
        allocatedPercent,
        loggedHours: logged,
        billableHours: toDecimal(billable),
        nonBillableHours: toDecimal(nonBillable),
        /** Logged against a 40h week — the standard utilisation ratio. */
        utilisationPercent: capacityHours.isZero()
          ? 0
          : Number(logged.dividedBy(capacityHours).times(100).toDecimalPlaces(1)),
        billableUtilisationPercent: capacityHours.isZero()
          ? 0
          : Number(toDecimal(billable).dividedBy(capacityHours).times(100).toDecimalPlaces(1)),
      };
    }),
  };
}

/**
 * One person's delivery record, for the resource detail page.
 *
 * The list view answers "is this person busy". This answers the harder
 * question a booker actually has: "can I give them the next piece of work, and
 * will it land on time". Those need different numbers — busy and reliable are
 * not the same property, and someone can be fully allocated while consistently
 * overrunning their estimates.
 *
 * Everything here is arithmetic over recorded history. Nothing is extrapolated:
 * a trend drawn from a handful of tasks would look authoritative and mean very
 * little, so the page shows the counts behind each ratio and lets the reader
 * judge whether there is enough of it to trust.
 */
export async function getResourceDetail(userId: string, weeks = 12) {
  await requirePermission(PERMISSIONS.PROJECT_RATES_READ);
  // Identical gate to getUtilisation. This page carries cost and billing rates
  // and one person's approval history, which is more sensitive than the roster,
  // never less — so it must not be reachable on a weaker permission.
  await requirePermission(PERMISSIONS.TIME_APPROVE);

  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setDate(from.getDate() - weeks * 7);
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);

  const STANDARD_WEEKLY_HOURS = 40;
  const capacityHours = toDecimal(STANDARD_WEEKLY_HOURS * weeks);

  const db = await supabaseServer();

  const [userRes, membershipsRes, tasksRes, logsRes] = await Promise.all([
    // Service role for the same reason as getUtilisation: the rate columns are
    // revoked from the authenticated role, and the check above is what governs
    // who gets this far.
    supabaseAdmin()
      .from("app_user")
      .select(
        `id, fullName, email, jobTitle, employeeNumber, status, costRate,
         defaultBillingRate, createdAt,
         department:app_user_departmentId_fkey ( id, name ),
         manager:managerUserId ( id, fullName )`,
      )
      .eq("id", userId)
      .is("deletedAt", null)
      .maybeSingle(),

    db
      .from("project_member")
      .select(
        `projectId, projectRole, allocationPercent, startDate, endDate, active,
         project!inner ( id, name, projectNumber, status, health, deletedAt )`,
      )
      .eq("userId", userId)
      .is("project.deletedAt", null),

    // Every task ever assigned, not just open ones: completed work is where
    // estimate accuracy comes from, and dropping it would leave only the
    // backlog — the half that cannot tell you how well someone delivers.
    db
      .from("project_task")
      .select(
        `id, name, status, priority, dueDate, completedDate, estimatedHours,
         completionPercent, projectId,
         project ( id, name, projectNumber )`,
      )
      .eq("assignedUserId", userId)
      .limit(500),

    db
      .from("time_log")
      .select(
        "id, hours, billable, workDate, approvalStatus, projectId, projectTaskId",
      )
      .eq("userId", userId)
      .gte("workDate", fromDay)
      .lte("workDate", toDay)
      .limit(2000),
  ]);

  // A failed query and a missing person are different things, and collapsing
  // both into null made the page render a 404 for a malformed select — which
  // looks exactly like "no such user" and hides the real fault. Throw on error
  // so it surfaces; return null only when the row genuinely is not there.
  //
  // 22P02 is the exception: Postgres raises it when the id in the URL is not a
  // uuid at all. Someone typing /resources/banana has asked for a record that
  // cannot exist, which is a 404 — not a server fault worth an error page.
  if (userRes.error) {
    if (userRes.error.code === "22P02") return null;
    throw new Error(`Could not load resource ${userId}: ${userRes.error.message}`);
  }
  if (!userRes.data) return null;

  const user = {
    ...userRes.data,
    department: one(userRes.data.department as never) as unknown as
      { id: string; name: string } | null,
    manager: one(userRes.data.manager as never) as unknown as
      { id: string; fullName: string } | null,
  };

  const memberships = (membershipsRes.data ?? []).map((m) => ({
    ...m,
    project: one(m.project as never) as unknown as {
      id: string; name: string; projectNumber: string; status: string; health: string | null;
    },
  }));

  const tasks = (tasksRes.data ?? []).map((t) => ({
    ...t,
    project: one(t.project as never) as unknown as
      { id: string; name: string; projectNumber: string } | null,
  }));

  const allLogs = await withRateSnapshots("time_log", logsRes.data ?? []);
  // Rejected time is excluded from every hours figure, matching getUtilisation
  // — it is work the business decided not to count. It is kept in `allLogs`
  // purely so the rejection rate below can be measured against the full set.
  const countedLogs = allLogs.filter((l) => l.approvalStatus !== "REJECTED");

  const sum = (rows: typeof allLogs, pick: (l: (typeof allLogs)[number]) => unknown) =>
    rows.reduce((acc, l) => acc.plus(toDecimal(pick(l) as never)), toDecimal(0));

  const loggedHours = sum(countedLogs, (l) => l.hours);
  const billableHours = sum(countedLogs.filter((l) => l.billable), (l) => l.hours);
  const nonBillableHours = loggedHours.minus(billableHours);

  // Margin is computed from the rates stamped on each entry, not the person's
  // current rate card, so a re-rate cannot rewrite what past work earned.
  const revenue = countedLogs
    .filter((l) => l.billable)
    .reduce(
      (acc, l) => acc.plus(toDecimal(l.hours).times(toDecimal(l.billingRate ?? 0))),
      toDecimal(0),
    );
  const cost = countedLogs.reduce(
    (acc, l) => acc.plus(toDecimal(l.hours).times(toDecimal(l.costRate ?? 0))),
    toDecimal(0),
  );

  // --- Time discipline -----------------------------------------------------
  const rejected = allLogs.filter((l) => l.approvalStatus === "REJECTED");
  const unsubmitted = allLogs.filter((l) => l.approvalStatus === "DRAFT");
  const awaitingApproval = allLogs.filter((l) => l.approvalStatus === "SUBMITTED");

  // --- Delivery ------------------------------------------------------------
  const todayDay = new Date().toISOString().slice(0, 10);
  const OPEN = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW"];
  const openTasks = tasks.filter((t) => OPEN.includes(String(t.status)));
  const completedTasks = tasks.filter((t) => t.status === "COMPLETED");
  const overdueTasks = openTasks.filter((t) => t.dueDate && String(t.dueDate) < todayDay);
  const blockedTasks = openTasks.filter((t) => t.status === "BLOCKED");

  // On-time delivery: only tasks that had a due date can be judged, so the
  // denominator is those — not every completed task, which would quietly
  // reward leaving dates off.
  const datedCompleted = completedTasks.filter((t) => t.dueDate && t.completedDate);
  const onTime = datedCompleted.filter((t) => String(t.completedDate) <= String(t.dueDate));

  // Estimate accuracy: actual hours booked to a task against what it was
  // estimated at. Only completed tasks that carry both an estimate and logged
  // time can say anything, and the count is returned so a ratio drawn from two
  // tasks is not mistaken for a pattern.
  const hoursByTask = new Map<string, Decimal>();
  for (const l of countedLogs) {
    if (!l.projectTaskId) continue;
    const key = String(l.projectTaskId);
    hoursByTask.set(key, (hoursByTask.get(key) ?? toDecimal(0)).plus(toDecimal(l.hours)));
  }
  const estimated = completedTasks
    .map((t) => ({
      task: t,
      estimate: toDecimal(t.estimatedHours ?? 0),
      actual: hoursByTask.get(String(t.id)) ?? toDecimal(0),
    }))
    .filter((e) => e.estimate.greaterThan(0) && e.actual.greaterThan(0));

  const totalEstimate = estimated.reduce((a, e) => a.plus(e.estimate), toDecimal(0));
  const totalActual = estimated.reduce((a, e) => a.plus(e.actual), toDecimal(0));

  // --- Weekly trend --------------------------------------------------------
  // Hours per week across the window, so a flat average cannot hide someone
  // who was flat out for a fortnight and idle since.
  const weekly: { weekStart: string; hours: number; billableHours: number }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = new Date(to);
    start.setDate(start.getDate() - w * 7 - 6);
    const end = new Date(to);
    end.setDate(end.getDate() - w * 7);
    const s = start.toISOString().slice(0, 10);
    const e = end.toISOString().slice(0, 10);
    const inWeek = countedLogs.filter(
      (l) => String(l.workDate) >= s && String(l.workDate) <= e,
    );
    weekly.push({
      weekStart: s,
      hours: Number(sum(inWeek, (l) => l.hours).toDecimalPlaces(1)),
      billableHours: Number(
        sum(inWeek.filter((l) => l.billable), (l) => l.hours).toDecimalPlaces(1),
      ),
    });
  }

  // --- Per project ---------------------------------------------------------
  // Allocation is the promise; hours are what happened. Showing them together
  // is what exposes a booking that never turned into work.
  const activeMemberships = memberships.filter((m) => m.active);
  const byProject = activeMemberships.map((m) => {
    const projectLogs = countedLogs.filter((l) => String(l.projectId) === String(m.projectId));
    const projectTasks = tasks.filter((t) => String(t.projectId) === String(m.projectId));
    return {
      project: m.project,
      projectRole: m.projectRole,
      allocationPercent: Number(m.allocationPercent ?? 0),
      hours: Number(sum(projectLogs, (l) => l.hours).toDecimalPlaces(1)),
      billableHours: Number(
        sum(projectLogs.filter((l) => l.billable), (l) => l.hours).toDecimalPlaces(1),
      ),
      openTasks: projectTasks.filter((t) => OPEN.includes(String(t.status))).length,
      overdueTasks: projectTasks.filter(
        (t) => OPEN.includes(String(t.status)) && t.dueDate && String(t.dueDate) < todayDay,
      ).length,
    };
  });

  const pct = (part: Decimal, whole: Decimal) =>
    whole.isZero() ? 0 : Number(part.dividedBy(whole).times(100).toDecimalPlaces(1));

  const allocatedPercent = activeMemberships.reduce(
    (s, m) => s + Number(m.allocationPercent ?? 0),
    0,
  );

  return {
    user,
    from,
    to,
    weeks,
    capacityHours,
    allocatedPercent,
    /** Capacity left on paper. Negative means booked past a full week. */
    headroomPercent: 100 - allocatedPercent,

    hours: {
      logged: loggedHours,
      billable: billableHours,
      nonBillable: nonBillableHours,
      utilisationPercent: pct(loggedHours, capacityHours),
      billableUtilisationPercent: pct(billableHours, capacityHours),
      billableRatioPercent: pct(billableHours, loggedHours),
    },

    margin: {
      revenue,
      cost,
      profit: revenue.minus(cost),
      marginPercent: pct(revenue.minus(cost), revenue),
    },

    delivery: {
      openTasks: openTasks.length,
      completedTasks: completedTasks.length,
      overdueTasks: overdueTasks.length,
      blockedTasks: blockedTasks.length,
      /** Denominator is completed tasks that had a due date — see above. */
      onTimePercent:
        datedCompleted.length === 0
          ? null
          : Math.round((onTime.length / datedCompleted.length) * 100),
      datedCompletedCount: datedCompleted.length,
    },

    estimates: {
      /** >100 means the work ran over its estimate. Null when nothing qualifies. */
      accuracyPercent: totalEstimate.isZero() ? null : pct(totalActual, totalEstimate),
      estimatedHours: totalEstimate,
      actualHours: totalActual,
      /** How many completed tasks this is drawn from — the trust signal. */
      sampleSize: estimated.length,
      worst: estimated
        .map((e) => ({
          id: String(e.task.id),
          name: String(e.task.name),
          project: e.task.project,
          estimate: Number(e.estimate.toDecimalPlaces(1)),
          actual: Number(e.actual.toDecimalPlaces(1)),
          overrunPercent: pct(e.actual.minus(e.estimate), e.estimate),
        }))
        .sort((a, b) => b.overrunPercent - a.overrunPercent)
        .slice(0, 5),
    },

    timeQuality: {
      entries: allLogs.length,
      rejectedEntries: rejected.length,
      rejectedPercent:
        allLogs.length === 0
          ? 0
          : Number(((rejected.length / allLogs.length) * 100).toFixed(1)),
      unsubmittedHours: sum(unsubmitted, (l) => l.hours),
      awaitingApprovalHours: sum(awaitingApproval, (l) => l.hours),
    },

    weekly,
    byProject,
    upcomingTasks: openTasks
      .filter((t) => t.dueDate)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .slice(0, 8),
  };
}
