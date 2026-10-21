"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { picklistCode } from "@/lib/picklists";
import { supabaseServer } from "@/lib/supabase";
import { createRecord, updateRecord } from "@/lib/db";
import { one } from "@/lib/decimal";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import type { ActionResult } from "./partners";
import { addWorkingMinutes } from "@/lib/business-hours";
import { loadWorkingCalendar } from "@/lib/working-calendar";

/**
 * Support cases (spec §10.3).
 *
 * Two rules are enforced here rather than in the UI:
 *   - A case always belongs to an Account *and* to a Contact of that Account.
 *     The schema allows a null contact (cases can arrive from an unknown
 *     sender), but a case raised through this app must name the person.
 *   - An open case needs an owner or a team — the same rule the database's
 *     `case_assignment_check` constraint enforces, checked here first so the
 *     user gets a sentence instead of a Postgres error.
 */

const OPEN_STATUSES = [
  "NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_FOR_CUSTOMER",
  "WAITING_FOR_INTERNAL_TEAM", "WAITING_FOR_THIRD_PARTY", "REOPENED",
] as const;

const caseSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().min(1, "Describe what the customer reported."),
  accountId: z.string().uuid(),
  contactId: z.string().uuid({ message: "Pick the contact who raised this." }),
  categoryId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid().optional().nullable(),
  teamId: z.string().uuid().optional().nullable(),
  slaPolicyId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  contractId: z.string().uuid().optional().nullable(),
  caseType: picklistCode.default("INCIDENT"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  source: picklistCode.default("EMAIL"),
});

/**
 * Wall-clock SLA deadlines from the matching policy.
 *
 * Working time: a policy of "4 hours" means four hours of the policy's
 * business hours (or the default ones), skipping evenings, days off and
 * holidays. With no business hours set up, time runs around the clock.
 */
async function slaDeadlines(
  slaPolicyId: string | null | undefined,
  priority: string,
  from: Date,
): Promise<{ slaPolicyId: string | null; firstResponseDueAt: Date | null; resolutionDueAt: Date | null }> {
  const db = await supabaseServer();

  const { data: policy } = slaPolicyId
    ? await db.from("sla_policy").select("*").eq("id", slaPolicyId).maybeSingle()
    : await db
        .from("sla_policy")
        .select("*")
        .eq("active", true)
        .eq("priority", priority)
        .limit(1)
        .maybeSingle();

  if (!policy) return { slaPolicyId: null, firstResponseDueAt: null, resolutionDueAt: null };

  const calendar = await loadWorkingCalendar(db, policy.businessHoursId);
  return {
    slaPolicyId: policy.id,
    firstResponseDueAt: addWorkingMinutes(from, policy.firstResponseMinutes, calendar),
    resolutionDueAt: addWorkingMinutes(from, policy.resolutionMinutes, calendar),
  };
}

export async function createCase(
  input: z.infer<typeof caseSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.CASE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (!data.ownerUserId && !data.teamId) {
    return {
      ok: false,
      error: "An open case needs an owner or a team - otherwise nobody is answering it.",
      fieldErrors: { ownerUserId: ["Assign a person or a team."] },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: contact } = await db
      .from("contact")
      .select("accountId, firstName, lastName")
      .eq("id", data.contactId)
      .maybeSingle();

    if (!contact) return { ok: false, error: "That contact no longer exists." };
    if (contact.accountId !== data.accountId) {
      return {
        ok: false,
        error: `${contact.firstName} ${contact.lastName} does not belong to the selected account.`,
      };
    }

    const now = new Date();
    const sla = await slaDeadlines(data.slaPolicyId, data.priority, now);

    const created = await createRecord<{ id: string }>(
      "support_case",
      {
        subject: data.subject,
        description: data.description,
        accountId: data.accountId,
        contactId: data.contactId,
        categoryId: data.categoryId ?? null,
        ownerUserId: data.ownerUserId ?? null,
        teamId: data.teamId ?? null,
        projectId: data.projectId ?? null,
        contractId: data.contractId ?? null,
        caseType: data.caseType,
        priority: data.priority,
        source: data.source,
        status: data.ownerUserId ? "ASSIGNED" : "NEW",
        slaPolicyId: sla.slaPolicyId,
        firstResponseDueAt: sla.firstResponseDueAt?.toISOString() ?? null,
        resolutionDueAt: sla.resolutionDueAt?.toISOString() ?? null,
      },
      { field: "caseNumber", sequence: SEQUENCES.CASE },
    );

    revalidatePath("/cases");
    revalidatePath(`/accounts/${data.accountId}`);
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the case." };
  }
}

const caseUpdateSchema = caseSchema.extend({
  status: z.enum([
    "NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_FOR_CUSTOMER",
    "WAITING_FOR_INTERNAL_TEAM", "WAITING_FOR_THIRD_PARTY",
    "RESOLVED", "CLOSED", "REOPENED", "CANCELLED",
  ]),
  rootCause: z.string().optional().nullable(),
  resolution: z.string().optional().nullable(),
  satisfactionScore: z.coerce.number().int().min(1).max(5).optional().nullable(),
});

export async function updateCase(
  id: string,
  input: z.infer<typeof caseUpdateSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.CASE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = caseUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  const stillOpen = (OPEN_STATUSES as readonly string[]).includes(data.status);
  if (stillOpen && !data.ownerUserId && !data.teamId) {
    return {
      ok: false,
      error: "An open case needs an owner or a team.",
      fieldErrors: { ownerUserId: ["Assign a person or a team."] },
    };
  }
  if ((data.status === "RESOLVED" || data.status === "CLOSED") && !data.resolution) {
    return {
      ok: false,
      error: "Record what actually fixed it before resolving or closing.",
      fieldErrors: { resolution: ["A resolution is required."] },
    };
  }

  const gate = await editGate("SupportCase", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("support_case")
      .select("status, resolvedAt, closedAt, reopenCount, resolutionDueAt, slaBreached")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Case not found." };

    const { data: contact } = await db
      .from("contact")
      .select("accountId")
      .eq("id", data.contactId)
      .maybeSingle();

    if (!contact || contact.accountId !== data.accountId) {
      return { ok: false, error: "The contact must belong to the selected account." };
    }

    const now = new Date();
    const reopening = before.status !== "REOPENED" && data.status === "REOPENED";
    const resolving =
      !before.resolvedAt && (data.status === "RESOLVED" || data.status === "CLOSED");

    // PostgREST returns timestamps as ISO strings — parse before comparing, or
    // `now > before.resolutionDueAt` compares a Date to a string and is always
    // false, so a breached SLA would silently record as met.
    const resolutionDueAt = before.resolutionDueAt
      ? new Date(before.resolutionDueAt as string)
      : null;

    await updateRecord(
      "support_case",
      id,
      {
        subject: data.subject,
        description: data.description,
        accountId: data.accountId,
        contactId: data.contactId,
        categoryId: data.categoryId ?? null,
        ownerUserId: data.ownerUserId ?? null,
        teamId: data.teamId ?? null,
        projectId: data.projectId ?? null,
        contractId: data.contractId ?? null,
        caseType: data.caseType,
        priority: data.priority,
        source: data.source,
        status: data.status,
        rootCause: data.rootCause ?? null,
        resolution: data.resolution ?? null,
        satisfactionScore: data.satisfactionScore ?? null,
        resolvedAt: resolving
          ? now.toISOString()
          : data.status === "REOPENED"
            ? null
            : before.resolvedAt,
        closedAt:
          data.status === "CLOSED"
            ? now.toISOString()
            : data.status === "REOPENED"
              ? null
              : before.closedAt,
        reopenCount: reopening ? Number(before.reopenCount ?? 0) + 1 : before.reopenCount,
        // §10.3: record whether the SLA was actually met, not just its deadline.
        slaBreached:
          resolving && resolutionDueAt ? now > resolutionDueAt : before.slaBreached,
      },
      "Case",
      user.id,
    );
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/cases");
    revalidatePath(`/cases/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the case." };
  }
}

/** Marks the first response, which is what SLA attainment is measured against. */
export async function recordFirstResponse(id: string): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.CASE_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  try {
    const db = await supabaseServer();

    const { data: before } = await db
      .from("support_case")
      .select("status, firstRespondedAt, firstResponseDueAt, slaBreached")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "Case not found." };
    if (before.firstRespondedAt) {
      return { ok: false, error: "First response is already recorded." };
    }

    const now = new Date();
    // Parse before comparing: PostgREST returns an ISO string, and Date > string
    // is always false, which would record a missed first response as on time.
    const firstResponseDueAt = before.firstResponseDueAt
      ? new Date(before.firstResponseDueAt as string)
      : null;

    await updateRecord(
      "support_case",
      id,
      {
        firstRespondedAt: now.toISOString(),
        status: before.status === "NEW" ? "IN_PROGRESS" : before.status,
        slaBreached:
          firstResponseDueAt && now > firstResponseDueAt ? true : before.slaBreached,
      },
      "Case",
      user.id,
    );

    revalidatePath(`/cases/${id}`);
    revalidatePath("/cases");
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not record the response." };
  }
}

export async function getCase(id: string) {
  await requirePermission(PERMISSIONS.CASE_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("support_case")
    .select(
      `*,
       account ( id, name, accountNumber ),
       contact ( id, firstName, lastName, email, phone ),
       owner:app_user!support_case_ownerUserId_fkey ( id, fullName, email ),
       team ( id, name ),
       category:case_category ( id, name ),
       slaPolicy:sla_policy ( id, name, firstResponseMinutes, resolutionMinutes ),
       project ( id, projectNumber, name ),
       contract ( id, contractNumber )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Could not load case: ${error.message}`);
  if (!data) return null;

  return {
    ...data,
    account: one(data.account as never),
    contact: one(data.contact as never),
    owner: one(data.owner as never),
    team: one(data.team as never),
    category: one(data.category as never),
    slaPolicy: one(data.slaPolicy as never),
    project: one(data.project as never),
    contract: one(data.contract as never),
  };
}

/** Everything the case form's dropdowns need. */
export async function getCaseFormOptions() {
  await requirePermission(PERMISSIONS.CASE_READ);

  const db = await supabaseServer();

  const [accounts, contacts, users, teams, categories, slaPolicies] = await Promise.all([
    db.from("account").select("id, name").is("deletedAt", null).order("name"),
    db
      .from("contact")
      .select("id, firstName, lastName, email, accountId")
      .is("deletedAt", null)
      .not("accountId", "is", null)
      .order("lastName")
      .order("firstName"),
    db
      .from("app_user")
      .select("id, fullName")
      .eq("status", "ACTIVE")
      .is("deletedAt", null)
      .order("fullName"),
    db.from("team").select("id, name").order("name"),
    db.from("case_category").select("id, name").eq("active", true).order("name"),
    db
      .from("sla_policy")
      .select("id, name, priority, firstResponseMinutes, resolutionMinutes")
      .eq("active", true)
      .order("priority"),
  ]);

  return {
    accounts: accounts.data ?? [],
    contacts: contacts.data ?? [],
    users: users.data ?? [],
    teams: teams.data ?? [],
    categories: categories.data ?? [],
    slaPolicies: slaPolicies.data ?? [],
  };
}
