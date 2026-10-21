"use server";

import { deleteToRecycleBin } from "./recycle-bin";
import { describeInvalid } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import Decimal from "decimal.js";
import { toDecimal, one } from "@/lib/decimal";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { createRecord, updateRecord, LIST_LIMIT } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, authorizeAny, requirePermission } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import { sanitizeRichText } from "@/lib/rich-text";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionResult } from "./partners";
import { MEMBER_PUBLIC_COLUMNS, TIME_PUBLIC_COLUMNS, withRateSnapshots } from "@/lib/rate-snapshots";
import { getProjectPeople } from "./project-directory";

/** The slice of the Supabase client the roll-up helper needs. */
type Db = Pick<SupabaseClient, "from">;

/**
 * Project delivery (spec §10.4).
 *
 * The shape follows how a professional-services engagement is actually run:
 * a project holds phases, phases hold milestones and tasks, people are booked
 * onto the project as members with an allocation percentage and rates, and
 * time is logged against tasks. Progress rolls **up** — task completion drives
 * phase completion drives project completion — rather than being typed in by
 * hand, so the number on the dashboard cannot drift from the work.
 */

// ---------------------------------------------------------------------------
// Progress roll-up
// ---------------------------------------------------------------------------

/**
 * Recomputes phase and project completion from task data.
 *
 * Tasks are weighted by estimated hours where they have them, so a 40-hour
 * task counts for more than a 2-hour one. Tasks with no estimate fall back to
 * equal weighting, which is the honest default when nobody has estimated yet.
 * Cancelled tasks drop out of the calculation entirely.
 */
async function rollUpProgress(db: Db, projectId: string): Promise<void> {
  const { data: taskRows } = await db
    .from("project_task")
    .select("id, phaseId, estimatedHours, completionPercent, status")
    .eq("projectId", projectId)
    .neq("status", "CANCELLED");

  const tasks = (taskRows ?? []) as Array<{
    id: string;
    phaseId: string | null;
    estimatedHours: unknown;
    completionPercent: unknown;
    status: string;
  }>;

  const weightOf = (t: (typeof tasks)[number]) => {
    const hours = Number(t.estimatedHours ?? 0);
    return hours > 0 ? hours : 1;
  };
  const progressOf = (t: (typeof tasks)[number]) =>
    t.status === "COMPLETED" ? 100 : Number(t.completionPercent);

  const weighted = (subset: typeof tasks) => {
    if (subset.length === 0) return null;
    const totalWeight = subset.reduce((s, t) => s + weightOf(t), 0);
    if (totalWeight === 0) return null;
    const done = subset.reduce((s, t) => s + weightOf(t) * progressOf(t), 0);
    return Math.round((done / totalWeight) * 100) / 100;
  };

  const { data: phases } = await db
    .from("project_phase")
    .select("id")
    .eq("projectId", projectId);

  // One upsert rather than an UPDATE per phase: a twelve-phase project was
  // twelve round trips, and this runs on every task change.
  const now = new Date().toISOString();
  const phaseUpdates = (phases ?? [])
    .map((phase) => ({ phase, pct: weighted(tasks.filter((t) => t.phaseId === phase.id)) }))
    .filter((u): u is { phase: { id: string }; pct: number } => u.pct !== null)
    .map(({ phase, pct }) => ({
      id: phase.id,
      completionPercent: pct,
      status: pct >= 100 ? "COMPLETED" : pct > 0 ? "ACTIVE" : "NOT_STARTED",
      updatedAt: now,
    }));

  if (phaseUpdates.length) {
    // These are updates, not inserts. An upsert also requires INSERT authority
    // and a complete new phase row before its conflict path is considered.
    const results = await Promise.all(phaseUpdates.map(({ id, ...values }) =>
      db.from("project_phase").update(values).eq("id", id).eq("projectId", projectId)));
    if (results.some((result) => result.error)) throw new Error("Could not update phase progress.");
  }

  const overall = weighted(tasks);
  if (overall !== null) {
    await db
      .from("project")
      .update({ completionPercent: overall, updatedAt: new Date().toISOString() })
      .eq("id", projectId);
  }
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const projectSchema = z
  .object({
    name: z.string().min(1).max(255),
    projectType: z.enum(["CUSTOMER", "INTERNAL"]).default("CUSTOMER"),
    accountId: z.string().uuid().optional().nullable(),
    opportunityId: z.string().uuid().optional().nullable(),
    contractId: z.string().uuid().optional().nullable(),
    // The catalogue product this work builds or delivers. Optional: plenty of
    // projects are not about a product at all.
    productId: z.string().uuid().optional().nullable(),
    projectManagerId: z.string().uuid(),
    status: z
      .enum(["DRAFT", "PLANNING", "ACTIVE", "ON_HOLD", "AT_RISK", "COMPLETED", "CANCELLED"])
      .default("DRAFT"),
    health: z.enum(["GREEN", "AMBER", "RED"]).default("GREEN"),
    billingType: z.enum(["FIXED", "HOURLY", "RETAINER", "MILESTONE", "ANNUAL"]),
    startDate: z.coerce.date().optional().nullable(),
    plannedEndDate: z.coerce.date().optional().nullable(),
    actualEndDate: z.coerce.date().optional().nullable(),
    contractValue: z.coerce.number().min(0).optional().nullable(),
    currencyCode: z.string().length(3).default("PKR"),
    approvedHours: z.coerce.number().min(0).optional().nullable(),
    scope: z.string().optional().nullable(),
  })
  // Mirrors the project_account_matches_type CHECK in the database, so the form
  // shows the problem against the field instead of surfacing a constraint error.
  // Internal work is cleared of its customer links rather than just refused: the
  // deal and contract only mean something for a customer, and leaving a stale
  // one behind is what makes internal work read as sold work later on.
  .superRefine((v, ctx) => {
    if (v.projectType === "CUSTOMER" && !v.accountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accountId"],
        message: "Choose the customer this project is for.",
      });
    }
  })
  // `productId` is deliberately NOT cleared for internal work: building your
  // own product on an internal project is the main reason the link exists.
  .transform((v) =>
    v.projectType === "INTERNAL"
      ? { ...v, accountId: null, opportunityId: null, contractId: null }
      : v,
  );

export async function createProject(
  input: z.input<typeof projectSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.startDate && data.plannedEndDate && data.plannedEndDate < data.startDate) {
    return {
      ok: false,
      error: "The planned end date cannot fall before the start date.",
      fieldErrors: { plannedEndDate: ["Must be on or after the start date."] },
    };
  }

  try {
    const db = await supabaseServer();

    // The project and its manager's membership are created together: without
    // that membership the manager cannot log time to their own project, and
    // the rate snapshot on it is what stops their time booking at zero cost
    // and quietly overstating the margin.
    const { data: project, error } = await db.rpc("create_project", {
      p_payload: {
        ...data,
        startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
        plannedEndDate: data.plannedEndDate
          ? data.plannedEndDate.toISOString().slice(0, 10)
          : null,
        actualEndDate: data.actualEndDate
          ? data.actualEndDate.toISOString().slice(0, 10)
          : null,
      },
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath("/projects");
    return { ok: true, data: { id: project.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the project." };
  }
}

export async function updateProject(
  id: string,
  input: z.input<typeof projectSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.startDate && data.plannedEndDate && data.plannedEndDate < data.startDate) {
    return {
      ok: false,
      error: "The planned end date cannot fall before the start date.",
      fieldErrors: { plannedEndDate: ["Must be on or after the start date."] },
    };
  }

  const gate = await editGate("Project", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    const db = await supabaseServer();

    // A newly chosen manager must be an active login; the database refuses
    // anyone else with a bare row-security message, so say it here first. A
    // manager left as it was is fine even if since switched off.
    const { data: current } = await db.from("project").select("projectManagerId").eq("id", id).maybeSingle();
    if (current && data.projectManagerId !== current.projectManagerId) {
      const { data: manager } = await supabaseAdmin().from("app_user").select("fullName, status, deletedAt, partnerId").eq("id", data.projectManagerId).maybeSingle();
      if (!manager || manager.status !== "ACTIVE" || manager.deletedAt || manager.partnerId) {
        return {
          ok: false,
          error: `${manager?.fullName ?? "That person"} cannot manage projects: their login is switched off. Choose an active colleague.`,
          fieldErrors: { projectManagerId: ["Choose an active colleague."] },
        };
      }
    }

    // Closing a project with work still open would leave those tasks stranded
    // on a completed project, so the check comes before the write.
    if (data.status === "COMPLETED") {
      const { count: openTasks } = await db
        .from("project_task")
        .select("id", { count: "exact", head: true })
        .eq("projectId", id)
        .not("status", "in", '("COMPLETED","CANCELLED")');

      if ((openTasks ?? 0) > 0) {
        return {
          ok: false,
          error: `${openTasks} task(s) are still open. Complete or cancel them before closing the project.`,
        };
      }
    }

    const actualEndDate =
      data.status === "COMPLETED"
        ? (data.actualEndDate ?? new Date())
        : data.actualEndDate;

    await updateRecord(
      "project",
      id,
      {
        ...data,
        startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
        plannedEndDate: data.plannedEndDate
          ? data.plannedEndDate.toISOString().slice(0, 10)
          : null,
        actualEndDate: actualEndDate ? actualEndDate.toISOString().slice(0, 10) : null,
      },
      "Project",
      user.id,
    );
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/projects");
    revalidatePath(`/projects/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the project." };
  }
}

/**
 * Deletes a project.
 *
 * A soft delete, recorded in the project's history: its tasks, time and
 * documents stay in the database, so nothing that referenced it breaks, and the
 * deal's implementation and training costs drop it straight away.
 *
 * Refused once money has been raised against it - an invoice pointing at a
 * vanished project is a hole in the books. Cancel the project instead.
 */
/** Only the Super Admin deletes; this is the recycle bin's delete, kept for its callers. */
export async function deleteProject(id: string, reason?: string | null): Promise<ActionResult> {
  return deleteToRecycleBin("Project", id, reason) as never;
}

export async function listProjects(filters?: {
  status?: string;
  search?: string;
  managerId?: string;
  projectType?: string;
}) {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  // members selects ids rather than using count(): 20260918000003 removed the
  // table-level SELECT grant on project_member so the rate columns stay
  // unreadable, and PostgREST's count() needs that grant. Column-level SELECT
  // still permits reading id, so the rows are counted in rowsOf below.
  let query = db
    .from("project")
    .select(
      `*,
       account ( id, name ),
       projectManager:app_user!project_projectManagerId_fkey ( id, fullName ),
       members:project_member ( id ),
       tasks:project_task ( count ),
       milestones:milestone ( count ),
       issues:project_issue ( count ),
       risks:project_risk ( count )`,
    )
    .is("deletedAt", null)
    .order("startDate", { ascending: false });

  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.projectType) query = query.eq("projectType", filters.projectType);
  if (filters?.managerId) query = query.eq("projectManagerId", filters.managerId);
  if (filters?.search) {
    // Prisma's OR also matched the related account's name. PostgREST cannot OR
    // across an embedded table, so the matching account ids are resolved first
    // and folded into the same clause — dropping it would narrow the search.
    const s = filters.search.replace(/[,()]/g, "");

    const { data: matchingAccounts } = await db
      .from("account")
      .select("id")
      .ilike("name", `%${s}%`)
      .is("deletedAt", null);

    const accountIds = (matchingAccounts ?? []).map((a) => a.id);
    const clauses = [`name.ilike.%${s}%`, `projectNumber.ilike.%${s}%`];
    if (accountIds.length) clauses.push(`accountId.in.(${accountIds.join(",")})`);

    query = query.or(clauses.join(","));
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load projects: ${error.message}`);

  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;
  /** For embeds returned as rows rather than an aggregate. */
  const rowsOf = (v: unknown) => (Array.isArray(v) ? v.length : 0);

  return (data ?? []).map((p) => ({
    ...p,
    account: one(p.account as never),
    projectManager: one(p.projectManager as never),
    _count: {
      members: rowsOf(p.members),
      tasks: countOf(p.tasks),
      milestones: countOf(p.milestones),
      issues: countOf(p.issues),
      risks: countOf(p.risks),
    },
  }));
}

export async function getProject(id: string) {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("project")
    .select(
      `*,
       account ( id, name, accountNumber ),
       opportunity ( id, opportunityNumber, name ),
       contract ( id, contractNumber ),
       product ( id, productCode, name, productType ),
       projectManager:app_user!project_projectManagerId_fkey ( id, fullName, email ),
       phases:project_phase ( * ),
       milestones:milestone (
         *,
         owner:app_user!milestone_ownerUserId_fkey ( id, fullName ),
         phase:project_phase ( id, name )
       ),
       tasks:project_task (
         *,
         assignedUser:app_user!project_task_assignedUserId_fkey ( id, fullName ),
         phase:project_phase ( id, name ),
         milestone ( id, name )
       ),
       members:project_member (
         ${MEMBER_PUBLIC_COLUMNS},
         user:app_user!project_member_userId_fkey ( id, fullName, jobTitle, email )
       ),
       risks:project_risk ( *, owner:app_user!project_risk_ownerUserId_fkey ( id, fullName ) ),
       issues:project_issue ( *, owner:app_user!project_issue_ownerUserId_fkey ( id, fullName ) ),
       changeRequests:change_request ( * ),
       cases:support_case ( id, caseNumber, subject, status, priority )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load project: ${error.message}`);
  if (!data) return null;

  // PostgREST returns embedded collections unordered, so the per-relation
  // orderBy from the Prisma query is applied here.
  type Row = Record<string, unknown>;
  const rows = (v: unknown) => ((v as Row[] | null) ?? []);
  const num = (v: unknown) => Number(v ?? 0);
  const asc = (a: unknown, b: unknown) => String(a ?? "").localeCompare(String(b ?? ""));
  const desc = (a: unknown, b: unknown) => String(b ?? "").localeCompare(String(a ?? ""));

  // Subtask counts are not available as an embedded aggregate alongside the
  // task's own columns, so they are derived from the task list itself.
  const taskRows = rows(data.tasks);

  // Hours booked per task, for sold-versus-used. Rejected time is left out: it
  // was sent back, so it neither used the budget nor gets billed.
  const { data: logged } = await db
    .from("time_log")
    .select("projectTaskId, hours")
    .eq("projectId", id)
    .not("projectTaskId", "is", null)
    .neq("approvalStatus", "REJECTED");
  const loggedByTask = new Map<string, number>();
  for (const l of logged ?? []) {
    const key = l.projectTaskId as string;
    loggedByTask.set(key, (loggedByTask.get(key) ?? 0) + Number(l.hours ?? 0));
  }

  const subtaskCount = new Map<string, number>();
  for (const t of taskRows) {
    const parent = t.parentTaskId as string | null;
    if (parent) subtaskCount.set(parent, (subtaskCount.get(parent) ?? 0) + 1);
  }

  return {
    ...data,
    account: one(data.account as never),
    opportunity: one(data.opportunity as never),
    contract: one(data.contract as never),
    product: one(data.product as never),
    projectManager: one(data.projectManager as never),
    phases: rows(data.phases).sort((a, b) => num(a.sequenceNumber) - num(b.sequenceNumber)),
    milestones: rows(data.milestones)
      .map((m): Row => ({ ...m, owner: one(m.owner as never), phase: one(m.phase as never) }))
      .sort((a, b) => asc(a.dueDate, b.dueDate)),
    tasks: taskRows
      .map((t): Row => ({
        ...t,
        assignedUser: one(t.assignedUser as never),
        phase: one(t.phase as never),
        milestone: one(t.milestone as never),
        loggedHours: String(loggedByTask.get(t.id as string) ?? 0),
        _count: { subtasks: subtaskCount.get(t.id as string) ?? 0 },
      }))
      .sort((a, b) => num(a.sortOrder) - num(b.sortOrder) || asc(a.createdAt, b.createdAt)),
    members: (await withRateSnapshots("project_member", rows(data.members) as Array<Row & { id: string }>))
      .map((m): Row => ({ ...m, user: one(m.user as never) }))
      .sort((a, b) => asc(a.createdAt, b.createdAt)),
    risks: rows(data.risks)
      .map((r): Row => ({ ...r, owner: one(r.owner as never) }))
      .sort((a, b) => num(b.riskScore) - num(a.riskScore)),
    issues: rows(data.issues)
      .map((i): Row => ({ ...i, owner: one(i.owner as never) }))
      .sort((a, b) => desc(a.createdAt, b.createdAt)),
    changeRequests: rows(data.changeRequests).sort((a, b) => desc(a.createdAt, b.createdAt)),
    cases: rows(data.cases),
  };
}

/** Hours and money actually consumed, for the workspace tiles. */
export async function getProjectBurn(projectId: string) {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  // PostgREST has no aggregate, so the hours are fetched and summed here.
  const [loggedRes, approvedRes] = await Promise.all([
    db
      .from("time_log")
      .select("hours")
      .eq("projectId", projectId)
      .neq("approvalStatus", "REJECTED"),
    db
      .from("time_log")
      .select("id, hours, billable")
      .eq("projectId", projectId)
      .eq("approvalStatus", "APPROVED"),
  ]);

  const loggedHours = (loggedRes.data ?? []).reduce(
    (sum, l) => sum.plus(toDecimal(l.hours)),
    toDecimal(0),
  );

  let billableValue = toDecimal(0);
  let cost = toDecimal(0);
  for (const log of await withRateSnapshots("time_log", approvedRes.data ?? [])) {
    const hours = toDecimal(log.hours);
    if (log.billable && log.billingRate) {
      billableValue = billableValue.plus(hours.times(toDecimal(log.billingRate)));
    }
    if (log.costRate) cost = cost.plus(hours.times(toDecimal(log.costRate)));
  }

  return {
    loggedHours,
    billableValue,
    cost,
  };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const phaseSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  ownerUserId: z.string().uuid().optional().nullable(),
  plannedStart: z.coerce.date().optional().nullable(),
  plannedEnd: z.coerce.date().optional().nullable(),
  budgetedHours: z.coerce.number().min(0).optional().nullable(),
});

export async function createPhase(
  input: z.infer<typeof phaseSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = phaseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    // Sequence number allocated under a lock on the project — reading the
    // current maximum and inserting separately lets two concurrent creates
    // collide on the same number.
    const { data: phase, error } = await db.rpc("create_ordered_child", {
      p_table: "project_phase",
      p_payload: {
        ...data,
        plannedStart: data.plannedStart
          ? data.plannedStart.toISOString().slice(0, 10)
          : null,
        plannedEnd: data.plannedEnd ? data.plannedEnd.toISOString().slice(0, 10) : null,
      },
      p_parent_field: "projectId",
      p_parent_id: data.projectId,
      p_seq_field: "sequenceNumber",
    });

    if (error) return { ok: false, error: error.message };

    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id: phase.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not add the phase." };
  }
}

export async function deletePhase(id: string): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    const db = await supabaseServer();

    const { data: phase } = await db
      .from("project_phase")
      .select("projectId, tasks:project_task ( id ), milestones:milestone ( id )")
      .eq("id", id)
      .maybeSingle();

    if (!phase) return { ok: false, error: "That phase no longer exists." };

    const taskCount = ((phase.tasks ?? []) as unknown[]).length;
    const milestoneCount = ((phase.milestones ?? []) as unknown[]).length;

    if (taskCount > 0 || milestoneCount > 0) {
      return {
        ok: false,
        error: "Move its tasks and milestones to another phase before deleting this one.",
      };
    }

    const { error } = await db.from("project_phase").delete().eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath(`/projects/${phase.projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not delete the phase." };
  }
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

const milestoneSchema = z.object({
  projectId: z.string().uuid(),
  phaseId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  ownerUserId: z.string().uuid().optional().nullable(),
  dueDate: z.coerce.date(),
  status: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED", "DELAYED"]).default("PLANNED"),
  customerApprovalRequired: z.boolean().default(false),
  billingTrigger: z.boolean().default(false),
  billingPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  billingAmount: z.coerce.number().min(0).optional().nullable(),
});

export async function createMilestone(
  input: z.infer<typeof milestoneSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = milestoneSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  // §13 milestone billing: a billing milestone must say what it bills.
  if (data.billingTrigger && !data.billingAmount && !data.billingPercent) {
    return {
      ok: false,
      error: "A billing milestone needs either an amount or a percentage of the contract value.",
      fieldErrors: { billingAmount: ["Set an amount or a percentage."] },
    };
  }

  try {
    const milestone = await createRecord<{ id: string }>("milestone", {
      ...data,
      dueDate: data.dueDate.toISOString().slice(0, 10),
    });
    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id: milestone.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not add the milestone." };
  }
}

export async function completeMilestone(
  id: string,
  customerApproved: boolean,
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("milestone")
      .select("projectId, customerApprovalRequired, customerApprovalDate")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That milestone no longer exists." };

    if (before.customerApprovalRequired && !customerApproved && !before.customerApprovalDate) {
      return {
        ok: false,
        error: "This milestone needs customer sign-off before it can be marked complete.",
      };
    }

    const { count: openTasks } = await db
      .from("project_task")
      .select("id", { count: "exact", head: true })
      .eq("milestoneId", id)
      .not("status", "in", '("COMPLETED","CANCELLED")');

    if ((openTasks ?? 0) > 0) {
      return { ok: false, error: `${openTasks} task(s) under this milestone are still open.` };
    }

    const now = new Date();

    await updateRecord(
      "milestone",
      id,
      {
        status: "COMPLETED",
        completedDate: now.toISOString().slice(0, 10),
        customerApprovalDate:
          before.customerApprovalRequired && customerApproved
            ? (before.customerApprovalDate ?? now.toISOString().slice(0, 10))
            : before.customerApprovalDate,
      },
      "Milestone",
      user.id,
    );

    const milestone = { projectId: before.projectId };

    revalidatePath(`/projects/${milestone.projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not complete the milestone." };
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const taskSchema = z.object({
  projectId: z.string().uuid(),
  phaseId: z.string().uuid().optional().nullable(),
  milestoneId: z.string().uuid().optional().nullable(),
  parentTaskId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  assignedUserId: z.string().uuid().optional().nullable(),
  status: z
    .enum(["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW", "COMPLETED", "CANCELLED"])
    .default("NOT_STARTED"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  startDate: z.coerce.date().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  estimatedHours: z.coerce.number().min(0).optional().nullable(),
  completionPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  billable: z.boolean().default(false),
  acceptanceCriteria: z.string().optional().nullable(),
  // What kind of work it is. Tasks no longer carry a price: what the customer
  // pays was settled on the deal, and a task that came from it records the
  // hours and rate sold (soldHours, soldRate), which are set by the database
  // when the deal is won and are not editable here.
  taskType: z.string().trim().max(100).optional().nullable(),
});


async function assertAssigneeIsOnProject(
  db: Db,
  projectId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;

  const { data: member } = await db
    .from("project_member")
    .select("active")
    .eq("projectId", projectId)
    .eq("userId", userId)
    .maybeSingle();

  if (!member || !member.active) {
    const { data: person } = await db
      .from("app_user")
      .select("fullName")
      .eq("id", userId)
      .maybeSingle();

    throw new Error(
      `${person?.fullName ?? "That user"} is not an active member of this project. Add them to the team first.`,
    );
  }
}

/**
 * Internal work is never billable, whatever the form sent.
 *
 * There is no customer on an internal project — `createProject` clears the
 * account, opportunity and contract for exactly that reason — so a task marked
 * billable there describes an invoice that can never be raised. Left alone, its
 * hours land in `billableValue`, in utilisation and in every margin figure, and
 * the company reads its own internal work back as sold work.
 *
 * Enforced here rather than only in the form: the checkbox is hidden for
 * internal projects, but a stale tab, a direct action call or a project later
 * converted from customer to internal would all still arrive with billable
 * true. The server owns the invariant.
 */
async function billableForProject(
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

export async function createTask(
  input: z.infer<typeof taskSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.startDate && data.dueDate && data.dueDate < data.startDate) {
    return {
      ok: false,
      error: "The due date cannot fall before the start date.",
      fieldErrors: { dueDate: ["Must be on or after the start date."] },
    };
  }

  try {
    const db = await supabaseServer();

    await assertAssigneeIsOnProject(db, data.projectId, data.assignedUserId);

    // sortOrder allocated under a lock on the project.
    const { data: task, error } = await db.rpc("create_ordered_child", {
      p_table: "project_task",
      p_payload: {
        ...data,
        billable: await billableForProject(db, data.projectId, data.billable),
        // Descriptions hold rich text now, and the point of the field is that
        // people paste into it. Cleaned here rather than trusting the editor:
        // the editor runs in a browser, so its output is whatever was posted.
        description: sanitizeRichText(data.description),
        acceptanceCriteria: sanitizeRichText(data.acceptanceCriteria),
        completionPercent: data.completionPercent ?? 0,
        startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
        dueDate: data.dueDate ? data.dueDate.toISOString().slice(0, 10) : null,
      },
      p_parent_field: "projectId",
      p_parent_id: data.projectId,
      p_seq_field: "sortOrder",
    });

    if (error) return { ok: false, error: error.message };

    // Roll-up runs after the insert: a failure here leaves the task created
    // and only the derived percentages stale, which the next write corrects.
    await rollUpProgress(db, data.projectId);

    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id: task.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the task." };
  }
}

export async function updateTask(
  id: string,
  input: z.infer<typeof taskSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (data.startDate && data.dueDate && data.dueDate < data.startDate) {
    return {
      ok: false,
      error: "The due date cannot fall before the start date.",
      fieldErrors: { dueDate: ["Must be on or after the start date."] },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("project_task")
      .select("completionPercent, completedDate")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That task no longer exists." };

    await assertAssigneeIsOnProject(db, data.projectId, data.assignedUserId);

    if (data.status === "COMPLETED") {
      const { count: openSubtasks } = await db
        .from("project_task")
        .select("id", { count: "exact", head: true })
        .eq("parentTaskId", id)
        .not("status", "in", '("COMPLETED","CANCELLED")');

      if ((openSubtasks ?? 0) > 0) {
        return { ok: false, error: `${openSubtasks} subtask(s) are still open.` };
      }
    }

    const completing = data.status === "COMPLETED";

    await updateRecord(
      "project_task",
      id,
      {
        ...data,
        billable: await billableForProject(db, data.projectId, data.billable),
        description: sanitizeRichText(data.description),
        acceptanceCriteria: sanitizeRichText(data.acceptanceCriteria),
        startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
        dueDate: data.dueDate ? data.dueDate.toISOString().slice(0, 10) : null,
        completionPercent: completing ? 100 : (data.completionPercent ?? before.completionPercent),
        completedDate: completing
          ? (before.completedDate ?? new Date().toISOString().slice(0, 10))
          : null,
      },
      "ProjectTask",
      user.id,
    );

    await rollUpProgress(db, data.projectId);

    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the task." };
  }
}

/** Board drag / quick status change — the one-field version of updateTask. */
export async function changeTaskStatus(
  id: string,
  status: string,
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = z
    .enum(["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW", "COMPLETED", "CANCELLED"])
    .safeParse(status);
  if (!parsed.success) return { ok: false, error: "Unknown task status." };

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("project_task")
      .select("projectId, completionPercent, completedDate")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "That task no longer exists." };

    if (parsed.data === "COMPLETED") {
      const { count: openSubtasks } = await db
        .from("project_task")
        .select("id", { count: "exact", head: true })
        .eq("parentTaskId", id)
        .not("status", "in", '("COMPLETED","CANCELLED")');

      if ((openSubtasks ?? 0) > 0) {
        return { ok: false, error: `${openSubtasks} subtask(s) are still open.` };
      }
    }

    const completing = parsed.data === "COMPLETED";

    await updateRecord(
      "project_task",
      id,
      {
        status: parsed.data,
        completionPercent: completing ? 100 : before.completionPercent,
        completedDate: completing
          ? (before.completedDate ?? new Date().toISOString().slice(0, 10))
          : null,
      },
      "ProjectTask",
      user.id,
    );

    await rollUpProgress(db, before.projectId);
    const projectId = before.projectId;

    revalidatePath(`/projects/${projectId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not change the task." };
  }
}

export async function getTask(id: string) {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("project_task")
    .select(
      `*,
       project ( id, name, projectNumber, projectType ),
       phase:project_phase ( id, name ),
       milestone ( id, name ),
       parentTask:parentTaskId ( id, name ),
       assignedUser:app_user!project_task_assignedUserId_fkey ( id, fullName ),
       timeLogs:time_log ( ${TIME_PUBLIC_COLUMNS}, user:app_user!time_log_userId_fkey ( id, fullName ) )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load task: ${error.message}`);
  if (!data) return null;

  // PostgREST cannot embed the reverse side of a self-referencing FK
  // (project_task.parentTaskId -> project_task.id), so subtasks are a second
  // query, as childAccounts and reports already are elsewhere.
  const { data: subtasks } = await db
    .from("project_task")
    .select("id, name, status, completionPercent, sortOrder")
    .eq("parentTaskId", id)
    .order("sortOrder");

  type Row = Record<string, unknown>;

  return {
    ...data,
    project: one(data.project as never),
    phase: one(data.phase as never),
    milestone: one(data.milestone as never),
    parentTask: one(data.parentTask as never),
    assignedUser: one(data.assignedUser as never),
    subtasks: subtasks ?? [],
    timeLogs: ((data.timeLogs ?? []) as Row[])
      .map((l): Row => ({ ...l, user: one(l.user as never) }))
      .sort((a, b) => String(b.workDate ?? "").localeCompare(String(a.workDate ?? ""))),
  };
}

/**
 * The project's work log: every entry, plus the four things a manager reads it
 * for.
 *
 * The project page already fetched a total and showed "Hours logged 0.0" — a
 * number with nothing behind it. The entries existed in time_log the whole
 * time; nothing ever displayed them, so there was no way to answer "what did
 * anyone actually do on this?" from the project itself.
 *
 * Everything is derived from one read of time_log. PostgREST has no aggregate,
 * so the grouping happens here, and doing it in one pass rather than four
 * queries keeps the page to a single round trip.
 *
 * Rejected entries are excluded from every total: a rejected line is one that
 * was disputed and thrown out, and counting it would overstate both effort and
 * cost. It still appears in the entry list, because the person who logged it
 * needs to see that it was rejected.
 */
export async function getProjectWorkLog(projectId: string, days = 30) {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("time_log")
    .select(
      `id, workDate, hours, description, billable, approvalStatus,
       startTime, endTime,
       user:app_user!time_log_userId_fkey ( id, fullName ),
       task:project_task ( id, name )`,
    )
    .eq("projectId", projectId)
    .order("workDate", { ascending: false })
    .order("createdAt", { ascending: false });

  if (error) throw new Error(`Could not load the work log: ${error.message}`);

  type LogRow = {
    id: string;
    workDate: string;
    hours: string;
    /** Null where the work was logged as a duration rather than clock times. */
    startTime: string | null;
    endTime: string | null;
    description: string;
    billable: boolean;
    approvalStatus: string;
    user: { id: string; fullName: string } | null;
    task: { id: string; name: string } | null;
  };

  const rows: LogRow[] = (data ?? []).map((r: Record<string, any>) => ({
    id: r.id,
    workDate: String(r.workDate),
    hours: String(r.hours),
    startTime: r.startTime ? String(r.startTime) : null,
    endTime: r.endTime ? String(r.endTime) : null,
    description: String(r.description ?? ""),
    billable: Boolean(r.billable),
    approvalStatus: String(r.approvalStatus),
    user: one(r.user as never) as { id: string; fullName: string } | null,
    task: one(r.task as never) as { id: string; name: string } | null,
  }));

  // Rejected time is excluded from the arithmetic but kept in the list.
  const counted = rows.filter((r) => r.approvalStatus !== "REJECTED");

  const totalHours = counted.reduce((sum, r) => sum.plus(toDecimal(r.hours)), toDecimal(0));
  const billableHours = counted
    .filter((r) => r.billable)
    .reduce((sum, r) => sum.plus(toDecimal(r.hours)), toDecimal(0));

  // Per person, so it is visible who is carrying the project and who has not
  // touched it this week.
  const byPersonMap = new Map<
    string,
    { userId: string; fullName: string; hours: ReturnType<typeof toDecimal>; billable: ReturnType<typeof toDecimal>; lastEntry: string | null }
  >();

  for (const r of counted) {
    const id = r.user?.id ?? "unknown";
    const entry = byPersonMap.get(id) ?? {
      userId: id,
      fullName: r.user?.fullName ?? "Unknown",
      hours: toDecimal(0),
      billable: toDecimal(0),
      lastEntry: null as string | null,
    };
    entry.hours = entry.hours.plus(toDecimal(r.hours));
    if (r.billable) entry.billable = entry.billable.plus(toDecimal(r.hours));
    // Rows arrive newest first, so the first one seen for a person is theirs.
    if (!entry.lastEntry) entry.lastEntry = String(r.workDate);
    byPersonMap.set(id, entry);
  }

  const byPerson = [...byPersonMap.values()]
    .map((p) => ({
      userId: p.userId,
      fullName: p.fullName,
      hours: p.hours.toString(),
      billableHours: p.billable.toString(),
      lastEntry: p.lastEntry,
    }))
    .sort((a, b) => Number(b.hours) - Number(a.hours));

  // A dense daily series for the trend: every day in the window appears, so a
  // gap in the work reads as a gap in the chart rather than being closed up.
  const today = new Date();
  const daily: { date: string; hours: number }[] = [];
  const hoursOnDate = new Map<string, number>();
  for (const r of counted) {
    const d = String(r.workDate).slice(0, 10);
    hoursOnDate.set(d, (hoursOnDate.get(d) ?? 0) + Number(r.hours));
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, hours: hoursOnDate.get(key) ?? 0 });
  }

  // "This week" runs from Monday, matching submitWeek() so the two never
  // disagree about which week an entry belongs to.
  const monday = new Date(today);
  const weekday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - weekday);
  const mondayKey = monday.toISOString().slice(0, 10);

  const thisWeekHours = counted
    .filter((r) => String(r.workDate).slice(0, 10) >= mondayKey)
    .reduce((sum, r) => sum.plus(toDecimal(r.hours)), toDecimal(0));

  const pendingApproval = rows.filter(
    (r) => r.approvalStatus === "SUBMITTED",
  ).length;

  return {
    entries: rows,
    totalHours: totalHours.toString(),
    billableHours: billableHours.toString(),
    nonBillableHours: totalHours.minus(billableHours).toString(),
    thisWeekHours: thisWeekHours.toString(),
    pendingApproval,
    byPerson,
    daily,
  };
}

// ---------------------------------------------------------------------------
// Resources — people booked onto the project
// ---------------------------------------------------------------------------

const memberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  projectRole: z.string().min(1).max(100),
  allocationPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
  billingRate: z.coerce.number().min(0).optional().nullable(),
  costRate: z.coerce.number().min(0).optional().nullable(),
});

/**
 * Books a person onto a project. Rates default to the person's standing rates
 * from their user record, so a project only carries an override when someone
 * has actually negotiated one.
 */
export async function addProjectMember(
  input: z.infer<typeof memberSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = memberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const db = await supabaseServer();

    const { data: existing } = await db
      .from("project_member")
      .select("id")
      .eq("projectId", data.projectId)
      .eq("userId", data.userId)
      .maybeSingle();

    if (existing) {
      return { ok: false, error: "That person is already on this project." };
    }

    // Service role: these two columns are revoked from the authenticated role
    // (20260902000000_hide_rate_columns.sql), and adding someone to a project
    // legitimately needs their standing rates to seed the membership. The
    // caller has already passed project:manage to reach this line.
    const { data: person } = await supabaseAdmin()
      .from("app_user")
      .select("costRate, defaultBillingRate")
      .eq("id", data.userId)
      .maybeSingle();

    if (!person) return { ok: false, error: "That user no longer exists." };

    // Rates are snapshotted onto the membership, so re-rating someone later
    // cannot rewrite what their past time on this project cost.
    const member = await createRecord<{ id: string }>("project_member", {
      ...data,
      startDate: data.startDate ? data.startDate.toISOString().slice(0, 10) : null,
      endDate: data.endDate ? data.endDate.toISOString().slice(0, 10) : null,
      billingRate: data.billingRate ?? person.defaultBillingRate,
      costRate: data.costRate ?? person.costRate,
    });

    revalidatePath(`/projects/${data.projectId}`);
    revalidatePath("/resources");
    return { ok: true, data: { id: member.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not add the team member." };
  }
}

export async function updateProjectMember(
  id: string,
  input: Omit<z.infer<typeof memberSchema>, "projectId" | "userId"> & { active: boolean },
): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const schema = memberSchema
    .omit({ projectId: true, userId: true })
    .extend({ active: z.boolean() });

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const db = await supabaseServer();

    const { data: member, error } = await db
      .from("project_member")
      .update({
        ...parsed.data,
        startDate: parsed.data.startDate
          ? parsed.data.startDate.toISOString().slice(0, 10)
          : parsed.data.startDate,
        endDate: parsed.data.endDate
          ? parsed.data.endDate.toISOString().slice(0, 10)
          : parsed.data.endDate,
        updatedAt: new Date().toISOString(),
      })
      .eq("id", id)
      .select("projectId")
      .single();

    if (error) throw new Error(error.message);

    revalidatePath(`/projects/${member.projectId}`);
    revalidatePath("/resources");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the team member." };
  }
}

/**
 * Removes someone from a project. If they have logged time we deactivate
 * instead of deleting — their hours are part of the project's cost record and
 * must not lose their owner.
 */
export async function removeProjectMember(id: string): Promise<ActionResult<{ deactivated: boolean }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    const db = await supabaseServer();

    const { data: member } = await db
      .from("project_member")
      .select("id, projectId, userId")
      .eq("id", id)
      .maybeSingle();

    if (!member) return { ok: false, error: "That team member is not on this project." };

    const { count: logged } = await db
      .from("time_log")
      .select("id", { count: "exact", head: true })
      .eq("projectId", member.projectId)
      .eq("userId", member.userId);

    const hasTime = (logged ?? 0) > 0;

    if (hasTime) {
      // Their hours are part of the project's cost record and must not lose
      // their owner, so deactivate rather than delete.
      await db
        .from("project_member")
        .update({
          active: false,
          endDate: new Date().toISOString().slice(0, 10),
          updatedAt: new Date().toISOString(),
        })
        .eq("id", id);
    } else {
      await db.from("project_member").delete().eq("id", id);
    }

    revalidatePath(`/projects/${member.projectId}`);
    revalidatePath("/resources");
    return { ok: true, data: { deactivated: hasTime } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not remove the team member." };
  }
}

// ---------------------------------------------------------------------------
// Risks and issues (RAID)
// ---------------------------------------------------------------------------

const riskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  probability: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  impact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  mitigationPlan: z.string().optional().nullable(),
  ownerUserId: z.string().uuid(),
  targetDate: z.coerce.date().optional().nullable(),
  status: z.enum(["OPEN", "MONITORING", "MITIGATED", "CLOSED"]).default("OPEN"),
});

/** Standard probability x impact matrix, 1–16. */
const LEVEL_SCORE: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export async function createRisk(
  input: z.infer<typeof riskSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = riskSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const risk = await createRecord<{ id: string }>("project_risk", {
      ...data,
      targetDate: data.targetDate ? data.targetDate.toISOString().slice(0, 10) : null,
      riskScore: LEVEL_SCORE[data.probability] * LEVEL_SCORE[data.impact],
    });
    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id: risk.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not log the risk." };
  }
}

const issueSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  ownerUserId: z.string().uuid(),
  resolutionPlan: z.string().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).default("OPEN"),
});

export async function createIssue(
  input: z.infer<typeof issueSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.PROJECT_MANAGE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  try {
    const issue = await createRecord<{ id: string }>("project_issue", {
      ...data,
      dueDate: data.dueDate ? data.dueDate.toISOString().slice(0, 10) : null,
    });
    revalidatePath(`/projects/${data.projectId}`);
    return { ok: true, data: { id: issue.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not log the issue." };
  }
}

// ---------------------------------------------------------------------------
// Form options
// ---------------------------------------------------------------------------

export async function getProjectFormOptions() {
  await requirePermission(PERMISSIONS.PROJECT_READ);

  const db = await supabaseServer();

  const [accountsRes, usersRes, opportunitiesRes, contractsRes, currenciesRes, productsRes] =
    await Promise.all([
      db.from("account").select("id, name").is("deletedAt", null).order("name"),
      getProjectPeople(),
      db
        .from("opportunity")
        .select("id, opportunityNumber, name, accountId")
        .is("deletedAt", null)
        .eq("stage", "CLOSED_WON")
        .order("name"),
      db
        .from("contract")
        .select("id, contractNumber, accountId")
        .is("deletedAt", null)
        .order("contractNumber"),
      db.from("currency").select("*").eq("active", true).order("code"),
      // Only products still on sale: linking new work to a retired one would
      // be a mistake nobody catches until the P&L looks wrong.
      db
        .from("product")
        .select("id, productCode, name, productType")
        .eq("active", true)
        .is("deletedAt", null)
        .order("name"),
    ]);

  const accounts = accountsRes.data ?? [];
  const users = usersRes;
  const opportunities = opportunitiesRes.data ?? [];
  const contracts = contractsRes.data ?? [];
  const currencies = currenciesRes.data ?? [];
  const products = productsRes.data ?? [];

  return { accounts, users, opportunities, contracts, currencies, products };
}

/**
 * Add tasks for products and services sold on the deal since the project began.
 *
 * Only ADDS. A line that already has a task is skipped, and nothing a project
 * manager changed on an existing task is touched - so pressing it twice, or
 * after rearranging the plan, is always safe.
 */
export async function syncProjectFromDeal(projectId: string): Promise<ActionResult<{ added: number }>> {
  const auth = await authorizeAny(PERMISSIONS.PROJECT_MANAGE, PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { data, error } = await db.rpc("sync_project_from_opportunity", { p_project: projectId });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, data: { added: (data as { added: number }).added } };
}
