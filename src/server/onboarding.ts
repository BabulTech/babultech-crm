"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { Resend } from "@/lib/mail";
import { renderDocumentEmail, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID } from "@/lib/email-template";
import { authorize, authorizeAny, requireUser, can, canAny, PERMISSIONS, type SessionUser } from "@/lib/authz";
import type { ActionResult } from "./partners";
import { PHASES } from "@/lib/onboarding";
import { startOnboardingFor } from "./onboarding-start";

/**
 * Customer onboarding.
 *
 * A playbook is an offering's list of steps. When a deal is won, an onboarding
 * is started from the playbook for the deal's offering: each step is copied
 * with its owner and due date, so editing a playbook later never changes a
 * customer already being onboarded. Ticking the Go live step makes the
 * customer Live.
 *
 * Service-role tables: every function checks permissions itself. Anyone with
 * deal or project access sees the onboarding list; anyone owning a step may
 * tick it; deal editors and the onboarding manager run the rest.
 */

const db = () => supabaseAdmin();
const now = () => new Date().toISOString();
const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);



function canSeeAll(user: SessionUser) {
  return canAny(user, PERMISSIONS.OPPORTUNITY_READ, PERMISSIONS.PROJECT_READ);
}
function canRun(user: SessionUser) {
  return canAny(user, PERMISSIONS.OPPORTUNITY_WRITE, PERMISSIONS.PROJECT_MANAGE);
}

function refresh(id?: string, opportunityId?: string | null) {
  revalidatePath("/onboarding");
  if (id) revalidatePath(`/onboarding/${id}`);
  if (opportunityId) revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath("/my-work");
}

async function audit(id: string, field: string, oldValue: string | null, newValue: string | null, actorId: string | null) {
  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "Onboarding", entityId: id, fieldName: field, oldValue, newValue,
    changedById: actorId, source: "UI", changedAt: now(),
  });
}

async function notify(userId: string | null, title: string, body: string, link: string, entityId: string) {
  if (!userId) return;
  try {
    await db().rpc("notify_user", { p_user: userId, p_kind: "ASSIGNED", p_title: title, p_body: body, p_link: link, p_entity_type: "Onboarding", p_entity_id: entityId });
  } catch (err) {
    console.error("Onboarding notification not sent:", err);
  }
}

function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export async function listPlaybooks() {
  await requireUser();
  const { data } = await db().from("onboarding_playbook")
    .select("id, name, description, targetDays, active, offeringId, offering ( name ), steps:onboarding_playbook_step ( id )")
    .order("name");
  return (data ?? []).map((p) => ({ ...p, offering: flat(p.offering) as { name: string } | null, stepCount: (p.steps ?? []).length }));
}

export async function getPlaybook(id: string) {
  await requireUser();
  const { data } = await db().from("onboarding_playbook").select("*, offering ( id, name )").eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: steps } = await db().from("onboarding_playbook_step").select("*, owner:app_user ( id, fullName )").eq("playbookId", id).order("sortOrder");
  return { ...data, offering: flat(data.offering) as { id: string; name: string } | null, steps: (steps ?? []).map((s) => ({ ...s, owner: flat(s.owner) as { id: string; fullName: string } | null })) };
}

const playbookSchema = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(120),
  offeringId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  targetDays: z.coerce.number().int().min(1).max(730).nullable().optional(),
  active: z.boolean().optional(),
});

export async function savePlaybook(id: string | null, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const parsed = playbookSchema.safeParse({
    ...input,
    offeringId: input.offeringId || null,
    targetDays: input.targetDays === "" || input.targetDays == null ? null : input.targetDays,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the fields." };
  const row = { ...parsed.data, offeringId: parsed.data.offeringId ?? null, description: parsed.data.description || null, targetDays: parsed.data.targetDays ?? null, updatedAt: now() };
  if (id) {
    const { error } = await db().from("onboarding_playbook").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await db().from("onboarding_playbook").insert(row).select("id").single();
    if (error) return { ok: false, error: error.message };
    id = data.id as string;
  }
  revalidatePath("/onboarding/playbooks");
  revalidatePath(`/onboarding/playbooks/${id}`);
  return { ok: true, data: { id: id! } };
}

const stepSchema = z.object({
  phase: z.enum(PHASES),
  title: z.string().trim().min(1, "Give the step a title.").max(200),
  instructions: z.string().trim().max(4000).nullable().optional(),
  ownerKind: z.enum(["DEAL_OWNER", "MANAGER", "USER"]),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueDays: z.coerce.number().int().min(0).max(730),
  stepType: z.enum(["INTERNAL", "CUSTOMER"]),
  requiresNote: z.boolean(),
  waitsForPrevious: z.boolean(),
  isGoLive: z.boolean(),
});

export async function savePlaybookStep(playbookId: string, stepId: string | null, input: Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const parsed = stepSchema.safeParse({
    ...input,
    ownerUserId: input.ownerUserId || null,
    requiresNote: input.requiresNote === true || input.requiresNote === "true",
    waitsForPrevious: input.waitsForPrevious === true || input.waitsForPrevious === "true",
    isGoLive: input.isGoLive === true || input.isGoLive === "true",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the step." };
  const d = parsed.data;
  if (d.ownerKind === "USER" && !d.ownerUserId) return { ok: false, error: "Choose the person who does this step." };
  const row = { ...d, ownerUserId: d.ownerKind === "USER" ? d.ownerUserId : null, instructions: d.instructions || null };
  if (stepId) {
    const { error } = await db().from("onboarding_playbook_step").update(row).eq("id", stepId).eq("playbookId", playbookId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data: last } = await db().from("onboarding_playbook_step").select("sortOrder").eq("playbookId", playbookId).order("sortOrder", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await db().from("onboarding_playbook_step").insert({ ...row, playbookId, sortOrder: (last?.sortOrder ?? 0) + 1 }).select("id").single();
    if (error) return { ok: false, error: error.message };
    stepId = data.id as string;
  }
  // Only one step can be the go-live moment.
  if (d.isGoLive) await db().from("onboarding_playbook_step").update({ isGoLive: false }).eq("playbookId", playbookId).neq("id", stepId!);
  revalidatePath(`/onboarding/playbooks/${playbookId}`);
  return { ok: true, data: { id: stepId! } };
}

export async function deletePlaybookStep(playbookId: string, stepId: string): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  await db().from("onboarding_playbook_step").delete().eq("id", stepId).eq("playbookId", playbookId);
  revalidatePath(`/onboarding/playbooks/${playbookId}`);
  return { ok: true, data: { id: stepId } };
}

export async function movePlaybookStep(playbookId: string, stepId: string, direction: -1 | 1): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const { data: steps } = await db().from("onboarding_playbook_step").select("id, sortOrder").eq("playbookId", playbookId).order("sortOrder");
  const list = steps ?? [];
  const i = list.findIndex((s) => s.id === stepId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= list.length) return { ok: true, data: { id: stepId } };
  [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map((s, k) => db().from("onboarding_playbook_step").update({ sortOrder: k + 1 }).eq("id", s.id)));
  revalidatePath(`/onboarding/playbooks/${playbookId}`);
  return { ok: true, data: { id: stepId } };
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export async function startOnboarding(opportunityId: string, playbookId: string | null): Promise<ActionResult<{ id: string }>> {
  const auth = await authorizeAny(PERMISSIONS.OPPORTUNITY_WRITE, PERMISSIONS.PROJECT_MANAGE);
  if (!auth.ok) return auth;
  const { data: opp } = await db().from("opportunity").select("stage").eq("id", opportunityId).maybeSingle();
  if (!opp) return { ok: false, error: "That opportunity no longer exists." };
  if (opp.stage !== "CLOSED_WON") return { ok: false, error: "Onboarding starts once the deal is Closed won." };
  const r = await startOnboardingFor(opportunityId, { playbookId, actor: auth.user });
  if (!r.ok) return r;
  if (!r.id) return { ok: false, error: r.reason ?? "No playbook to start from." };
  return { ok: true, data: { id: r.id } };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface OnboardingRow {
  id: string; onboardingNumber: string; accountId: string; opportunityId: string | null; playbookId: string | null; offeringId: string | null;
  name: string; status: string; managerUserId: string | null; startDate: string; targetGoLive: string | null; wentLiveAt: string | null; cancelReason: string | null;
}
type FullStep = StepRow & { phase: string; instructions: string | null; requiresNote: boolean; note: string | null; doneAt: string | null; owner: { id: string; fullName: string } | null; doneBy: { fullName: string } | null };
type StepRow = { id: string; status: string; dueDate: string | null; stepType: string; ownerUserId: string | null; isGoLive: boolean; sortOrder: number; waitsForPrevious: boolean; title: string };

function summarise(steps: StepRow[]) {
  const sorted = [...steps].sort((a, b) => a.sortOrder - b.sortOrder);
  const open = sorted.filter((s) => s.status === "TODO");
  const done = sorted.filter((s) => s.status !== "TODO").length;
  const overdue = open.filter((s) => s.dueDate && s.dueDate < today()).length;
  const waitingOnCustomer = open.length > 0 && open.every((s) => s.stepType === "CUSTOMER");
  return { total: sorted.length, done, overdue, waitingOnCustomer, next: open[0] ?? null };
}

/** Whether a step may be ticked yet: one waiting for the previous needs it done first. */
function blocked(step: StepRow, all: StepRow[]) {
  if (!step.waitsForPrevious) return false;
  const prev = [...all].sort((a, b) => a.sortOrder - b.sortOrder).filter((s) => s.sortOrder < step.sortOrder).pop();
  return Boolean(prev && prev.status === "TODO");
}

export async function listOnboardings(filters: { status?: string; offeringId?: string; managerUserId?: string; overdue?: boolean; search?: string } = {}) {
  const user = await requireUser();
  let mineOnly: string[] | null = null;
  if (!canSeeAll(user)) {
    const { data } = await db().from("onboarding_step").select("onboardingId").eq("ownerUserId", user.id);
    mineOnly = [...new Set((data ?? []).map((s) => s.onboardingId as string))];
    if (!mineOnly.length) return [];
  }
  let q = db().from("onboarding")
    .select("*, account ( id, name ), offering ( name ), manager:app_user!onboarding_managerUserId_fkey ( fullName ), steps:onboarding_step ( id, status, dueDate, stepType, ownerUserId, isGoLive, sortOrder, waitsForPrevious, title )")
    .order("createdAt", { ascending: false }).limit(500);
  if (mineOnly) q = q.in("id", mineOnly);
  q = q.eq("status", filters.status || "ACTIVE");
  if (filters.offeringId) q = q.eq("offeringId", filters.offeringId);
  if (filters.managerUserId) q = q.eq("managerUserId", filters.managerUserId);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load onboarding: ${error.message}`);
  let rows = (data ?? []).map((o) => ({
    ...o,
    account: flat(o.account) as { id: string; name: string } | null,
    offering: flat(o.offering) as { name: string } | null,
    manager: flat(o.manager) as { fullName: string } | null,
    summary: summarise((o.steps ?? []) as StepRow[]),
  }));
  if (filters.search) {
    const s = filters.search.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(s) || r.onboardingNumber.toLowerCase().includes(s) || r.account?.name.toLowerCase().includes(s));
  }
  if (filters.overdue) rows = rows.filter((r) => r.summary.overdue > 0);
  return rows;
}

export async function getOnboarding(id: string) {
  const user = await requireUser();
  const { data: row } = await db().from("onboarding")
    .select("*, account ( id, name ), opportunity ( id, name, opportunityNumber ), offering ( name ), playbook:onboarding_playbook ( name ), manager:app_user!onboarding_managerUserId_fkey ( id, fullName )")
    .eq("id", id).maybeSingle();
  const o = row as (OnboardingRow & { account: unknown; opportunity: unknown; offering: unknown; playbook: unknown; manager: unknown }) | null;
  if (!o) return null;
  // One round trip for the rest: each query is ~0.4s away, and this page is
  // re-rendered after every tick, so running them one after another made
  // ticking a step feel stuck.
  const [{ data: steps }, { data: projects }, { data: contacts }, { data: history }] = await Promise.all([
    db().from("onboarding_step")
      .select("*, owner:app_user!onboarding_step_ownerUserId_fkey ( id, fullName ), doneBy:app_user!onboarding_step_doneById_fkey ( fullName )")
      .eq("onboardingId", id).order("sortOrder"),
    o.opportunityId
      ? db().from("project").select("id, name, projectNumber").eq("opportunityId", o.opportunityId).is("deletedAt", null)
      : Promise.resolve({ data: [] as { id: string; name: string; projectNumber: string }[] }),
    db().from("contact").select("id, firstName, lastName, email").eq("accountId", o.accountId).is("deletedAt", null).not("email", "is", null),
    db().from("audit_history").select("id, fieldName, oldValue, newValue, changedAt, changedBy:app_user ( fullName )")
      .eq("entityType", "Onboarding").eq("entityId", id).order("changedAt", { ascending: false }).limit(50),
  ]);
  const list = (steps ?? []).map((s) => ({ ...s, owner: flat(s.owner) as { id: string; fullName: string } | null, doneBy: flat(s.doneBy) as { fullName: string } | null }));
  const mine = list.some((s) => s.ownerUserId === user.id);
  if (!canSeeAll(user) && !mine && o.managerUserId !== user.id) return null;

  return {
    ...o,
    account: flat(o.account) as { id: string; name: string } | null,
    opportunity: flat(o.opportunity) as { id: string; name: string; opportunityNumber: string } | null,
    offering: flat(o.offering) as { name: string } | null,
    playbook: flat(o.playbook) as { name: string } | null,
    manager: flat(o.manager) as { id: string; fullName: string } | null,
    steps: list.map((s) => ({ ...(s as unknown as FullStep), blocked: blocked(s as StepRow, list as StepRow[]) })),
    summary: summarise(list as StepRow[]),
    projects: (projects ?? []) as { id: string; name: string; projectNumber: string }[],
    contacts: (contacts ?? []) as { id: string; firstName: string; lastName: string; email: string }[],
    history: (history ?? []).map((h) => ({ ...h, changedBy: flat(h.changedBy) as { fullName: string } | null })) as { id: string; fieldName: string; oldValue: string | null; newValue: string | null; changedAt: string; changedBy: { fullName: string } | null }[],
    canRun: canRun(user) || o.managerUserId === user.id,
    me: user.id,
  };
}

/**
 * The checklist and its status, for the page to redraw itself straight after
 * an action rather than waiting for a full page refresh.
 */
export async function getOnboardingChecklist(id: string) {
  const o = await getOnboarding(id);
  if (!o) return null;
  return { steps: o.steps, summary: o.summary, status: o.status, wentLiveAt: o.wentLiveAt, history: o.history };
}

export async function getOnboardingForOpportunity(opportunityId: string) {
  await requireUser();
  const { data } = await db().from("onboarding").select("id, onboardingNumber, status, targetGoLive, steps:onboarding_step ( id, status, dueDate, stepType, ownerUserId, isGoLive, sortOrder, waitsForPrevious, title )").eq("opportunityId", opportunityId).maybeSingle();
  if (!data) return null;
  return { ...data, summary: summarise((data.steps ?? []) as StepRow[]) };
}

export async function listOnboardingsForAccount(accountId: string) {
  await requireUser();
  const { data } = await db().from("onboarding").select("id, onboardingNumber, name, status, targetGoLive, wentLiveAt, steps:onboarding_step ( id, status, dueDate, stepType, ownerUserId, isGoLive, sortOrder, waitsForPrevious, title )").eq("accountId", accountId).order("createdAt", { ascending: false });
  return (data ?? []).map((o) => ({ ...o, summary: summarise((o.steps ?? []) as StepRow[]) }));
}

/** Open steps owned by the signed-in person, for My work. */
export async function listMyOnboardingSteps() {
  const user = await requireUser();
  const { data } = await db().from("onboarding_step")
    .select("id, title, dueDate, stepType, onboarding ( id, onboardingNumber, name, status )")
    .eq("ownerUserId", user.id).eq("status", "TODO").order("dueDate").limit(50);
  return (data ?? []).map((s) => ({ ...s, onboarding: flat(s.onboarding) as { id: string; onboardingNumber: string; name: string; status: string } | null }))
    // Follow-up steps carry on after the customer is live.
    .filter((s) => s.onboarding?.status === "ACTIVE" || s.onboarding?.status === "LIVE");
}

// ---------------------------------------------------------------------------
// Working the steps
// ---------------------------------------------------------------------------

async function loadStep(stepId: string) {
  const { data: step } = await db().from("onboarding_step").select("*, onboarding ( id, status, managerUserId, opportunityId, accountId, name, onboardingNumber )").eq("id", stepId).maybeSingle();
  if (!step) return null;
  return { step, onboarding: flat(step.onboarding) as { id: string; status: string; managerUserId: string | null; opportunityId: string | null; accountId: string; name: string; onboardingNumber: string } };
}

export async function completeStep(stepId: string, note: string | null): Promise<ActionResult<{ id: string; wentLive: boolean }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const loaded = await loadStep(stepId);
  if (!loaded) return { ok: false, error: "That step no longer exists." };
  const { step, onboarding } = loaded;
  const allowed = step.ownerUserId === auth.user.id || onboarding.managerUserId === auth.user.id || canRun(auth.user);
  if (!allowed) return { ok: false, error: "Only the step's owner or the onboarding manager can tick it." };
  if (onboarding.status !== "ACTIVE") return { ok: false, error: "This onboarding is no longer active." };
  if (step.status !== "TODO") return { ok: false, error: "That step is already done." };
  if (step.requiresNote && !note?.trim()) return { ok: false, error: "This step needs a note saying what was done." };
  const { data: all } = await db().from("onboarding_step").select("id, status, sortOrder, waitsForPrevious, dueDate, stepType, ownerUserId, isGoLive, title").eq("onboardingId", onboarding.id);
  if (blocked(step as StepRow, (all ?? []) as StepRow[])) return { ok: false, error: "This step waits for the one before it. Finish that first." };

  await db().from("onboarding_step").update({ status: "DONE", doneById: auth.user.id, doneAt: now(), note: note?.trim() || null }).eq("id", stepId);
  await audit(onboarding.id, "step", step.title, "Done", auth.user.id);

  // The next step that was waiting on this one can start: tell its owner.
  const next = ((all ?? []) as StepRow[]).filter((s) => s.sortOrder > step.sortOrder && s.status === "TODO").sort((a, b) => a.sortOrder - b.sortOrder)[0];
  if (next?.waitsForPrevious && next.ownerUserId && next.ownerUserId !== auth.user.id) {
    await notify(next.ownerUserId, `Ready for you: ${next.title}`, `${onboarding.name} (${onboarding.onboardingNumber})`, `/onboarding/${onboarding.id}`, onboarding.id);
  }

  let wentLive = false;
  if (step.isGoLive) {
    wentLive = true;
    await db().from("onboarding").update({ status: "LIVE", wentLiveAt: now(), updatedAt: now() }).eq("id", onboarding.id);
    await audit(onboarding.id, "status", "ACTIVE", "LIVE", auth.user.id);
    if (onboarding.managerUserId && onboarding.managerUserId !== auth.user.id) {
      await notify(onboarding.managerUserId, `${onboarding.name} is live`, "The go-live step was completed. Follow-up steps stay on the list.", `/onboarding/${onboarding.id}`, onboarding.id);
    }
  }
  refresh(onboarding.id, onboarding.opportunityId);
  return { ok: true, data: { id: stepId, wentLive } };
}

export async function reopenStep(stepId: string): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const loaded = await loadStep(stepId);
  if (!loaded) return { ok: false, error: "That step no longer exists." };
  const { step, onboarding } = loaded;
  if (!(onboarding.managerUserId === auth.user.id || canRun(auth.user) || step.doneById === auth.user.id)) return { ok: false, error: "Only the onboarding manager can reopen a step." };
  await db().from("onboarding_step").update({ status: "TODO", doneById: null, doneAt: null }).eq("id", stepId);
  await audit(onboarding.id, "step", step.title, "Reopened", auth.user.id);
  if (step.isGoLive && onboarding.status === "LIVE") {
    await db().from("onboarding").update({ status: "ACTIVE", wentLiveAt: null, updatedAt: now() }).eq("id", onboarding.id);
    await audit(onboarding.id, "status", "LIVE", "ACTIVE", auth.user.id);
  }
  refresh(onboarding.id, onboarding.opportunityId);
  return { ok: true, data: { id: stepId } };
}

async function requireRunner(onboardingId: string, user: SessionUser) {
  const { data: o } = await db().from("onboarding").select("id, managerUserId, opportunityId, status, name, onboardingNumber").eq("id", onboardingId).maybeSingle();
  if (!o) return { error: "That onboarding no longer exists." } as const;
  if (!(o.managerUserId === user.id || canRun(user))) return { error: "Only the onboarding manager or someone who can edit deals can do that." } as const;
  return { o } as const;
}

export async function skipStep(stepId: string, reason: string): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const loaded = await loadStep(stepId);
  if (!loaded) return { ok: false, error: "That step no longer exists." };
  const r = await requireRunner(loaded.onboarding.id, auth.user);
  if ("error" in r) return { ok: false, error: r.error! };
  if (!reason.trim()) return { ok: false, error: "Say why the step is being skipped." };
  if (loaded.step.isGoLive) return { ok: false, error: "The go-live step cannot be skipped - tick it when the customer is live." };
  await db().from("onboarding_step").update({ status: "SKIPPED", doneById: auth.user.id, doneAt: now(), note: `Skipped: ${reason.trim()}` }).eq("id", stepId);
  await audit(loaded.onboarding.id, "step", loaded.step.title, "Skipped", auth.user.id);
  refresh(loaded.onboarding.id, loaded.onboarding.opportunityId);
  return { ok: true, data: { id: stepId } };
}

export async function updateStep(stepId: string, input: { ownerUserId?: string | null; dueDate?: string | null }): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const loaded = await loadStep(stepId);
  if (!loaded) return { ok: false, error: "That step no longer exists." };
  const r = await requireRunner(loaded.onboarding.id, auth.user);
  if ("error" in r) return { ok: false, error: r.error! };
  const patch: Record<string, unknown> = {};
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId || null;
  if (input.dueDate !== undefined) {
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return { ok: false, error: "Choose a date." };
    patch.dueDate = input.dueDate || null;
  }
  await db().from("onboarding_step").update(patch).eq("id", stepId);
  if (patch.ownerUserId && patch.ownerUserId !== loaded.step.ownerUserId) {
    await audit(loaded.onboarding.id, "stepOwner", loaded.step.title, String(patch.ownerUserId), auth.user.id);
    if (patch.ownerUserId !== auth.user.id) await notify(patch.ownerUserId as string, `Onboarding step for you: ${loaded.step.title}`, `${loaded.onboarding.name} (${loaded.onboarding.onboardingNumber})`, `/onboarding/${loaded.onboarding.id}`, loaded.onboarding.id);
  }
  refresh(loaded.onboarding.id, loaded.onboarding.opportunityId);
  return { ok: true, data: { id: stepId } };
}

export async function updateOnboarding(id: string, input: { managerUserId?: string | null; targetGoLive?: string | null; cancelReason?: string | null; cancel?: boolean; reactivate?: boolean }): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const r = await requireRunner(id, auth.user);
  if ("error" in r) return { ok: false, error: r.error! };
  const patch: Record<string, unknown> = { updatedAt: now() };
  if (input.managerUserId !== undefined) patch.managerUserId = input.managerUserId || null;
  if (input.targetGoLive !== undefined) patch.targetGoLive = input.targetGoLive || null;
  if (input.cancel) {
    if (!input.cancelReason?.trim()) return { ok: false, error: "Say why onboarding is being cancelled." };
    patch.status = "CANCELLED";
    patch.cancelReason = input.cancelReason.trim();
  }
  if (input.reactivate) { patch.status = "ACTIVE"; patch.cancelReason = null; }
  await db().from("onboarding").update(patch).eq("id", id);
  for (const k of ["managerUserId", "targetGoLive", "status"] as const) {
    if (patch[k] !== undefined) await audit(id, k, null, patch[k] == null ? null : String(patch[k]), auth.user.id);
  }
  refresh(id, r.o.opportunityId);
  return { ok: true, data: { id } };
}

/** Emails the customer the list of what we still need from them. */
export async function emailCustomerChecklist(id: string, contactIds: string[], message: string | null): Promise<ActionResult<{ sentTo: string[] }>> {
  const auth = await authorize();
  if (!auth.ok) return auth;
  const r = await requireRunner(id, auth.user);
  if ("error" in r) return { ok: false, error: r.error! };
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "Email is not set up." };
  const { data: o } = await db().from("onboarding").select("accountId, name, onboardingNumber, account ( name )").eq("id", id).single();
  const { data: steps } = await db().from("onboarding_step").select("title, instructions, dueDate").eq("onboardingId", id).eq("stepType", "CUSTOMER").eq("status", "TODO").order("sortOrder");
  if (!steps?.length) return { ok: false, error: "Nothing is waiting on the customer." };
  const { data: contacts } = await db().from("contact").select("id, firstName, email").in("id", contactIds.length ? contactIds : ["00000000-0000-0000-0000-000000000000"]).eq("accountId", o!.accountId);
  const to = (contacts ?? []).map((c) => c.email as string).filter(Boolean);
  if (!to.length) return { ok: false, error: "Choose at least one contact with an email address." };

  const { data: settings } = await db().from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const list = steps.map((s) => `<li><strong>${esc(s.title)}</strong>${s.dueDate ? ` - by ${s.dueDate}` : ""}${s.instructions ? `<br><span style="color:#555">${esc(s.instructions)}</span>` : ""}</li>`).join("");
  const greeting = (contacts ?? []).length === 1 ? `Dear ${esc(String(contacts![0].firstName ?? ""))},` : "Hello,";
  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: "What we need from you",
    message: "",
    messageHtml: `<p>${greeting}</p><p>${message ? esc(message).replace(/\n/g, "<br>") : "To get you up and running, we need the following from you:"}</p><ul>${list}</ul><p>Simply reply to this email with the items, or let us know if you have any questions.</p>`,
    summary: [{ label: "Reference", value: o!.onboardingNumber }],
    senderName: auth.user.fullName,
    senderTitle: auth.user.jobTitle,
  });
  const sent = await new Resend(process.env.RESEND_API_KEY, "Onboarding checklist").emails.send({
    from: process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>", to,
    replyTo: auth.user.email, subject: `${(flat(o!.account) as { name: string } | null)?.name ?? "Your onboarding"}: what we need from you`, html, text,
  });
  if (sent.error) return { ok: false, error: `The email failed: ${sent.error.message}` };
  await audit(id, "customerChecklist", null, to.join(", "), auth.user.id);
  refresh(id);
  return { ok: true, data: { sentTo: to } };
}
