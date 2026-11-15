import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase";
import { SEQUENCES } from "@/lib/numbering";
import type { SessionUser } from "@/lib/authz";

/** Not a server action: only server code may start onboarding as a given user. */

const db = () => supabaseAdmin();
const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const today = () => new Date().toISOString().slice(0, 10);
function addDays(day: string, days: number) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
async function audit(id: string, field: string, oldValue: string | null, newValue: string | null, actorId: string | null) {
  await db().from("audit_history").insert({ id: crypto.randomUUID(), entityType: "Onboarding", entityId: id, fieldName: field, oldValue, newValue, changedById: actorId, source: "UI", changedAt: new Date().toISOString() });
}
async function notify(userId: string | null, title: string, body: string, link: string, entityId: string) {
  if (!userId) return;
  try { await db().rpc("notify_user", { p_user: userId, p_kind: "ASSIGNED", p_title: title, p_body: body, p_link: link, p_entity_type: "Onboarding", p_entity_id: entityId }); } catch (err) { console.error("Onboarding notification not sent:", err); }
}
function refresh(id: string, opportunityId: string) { revalidatePath("/onboarding"); revalidatePath(`/onboarding/${id}`); revalidatePath(`/opportunities/${opportunityId}`); revalidatePath("/my-work"); }

/**
 * Starts onboarding for a won deal. Called by changeStage on Closed won (as the
 * system, `actor` given), and by the Start onboarding button. Picks the
 * playbook for the deal's offering unless one is named. Does nothing if the
 * deal already has one.
 */
export async function startOnboardingFor(
  opportunityId: string,
  options: { playbookId?: string | null; actor: SessionUser },
): Promise<{ ok: true; id: string | null; reason?: string } | { ok: false; error: string }> {
  const { data: opp } = await db().from("opportunity").select("id, name, accountId, ownerUserId, offeringId, stage, account ( name )").eq("id", opportunityId).maybeSingle();
  if (!opp) return { ok: false, error: "That opportunity no longer exists." };
  const { data: existing } = await db().from("onboarding").select("id").eq("opportunityId", opportunityId).maybeSingle();
  if (existing) return { ok: true, id: existing.id };

  let playbookId = options.playbookId ?? null;
  if (!playbookId) {
    if (!opp.offeringId) return { ok: true, id: null, reason: "The deal has no offering, so no playbook was chosen. Set the offering and start onboarding from the deal." };
    const { data: pb } = await db().from("onboarding_playbook").select("id").eq("offeringId", opp.offeringId).eq("active", true).order("createdAt").limit(1).maybeSingle();
    if (!pb) return { ok: true, id: null, reason: "This offering has no onboarding playbook yet." };
    playbookId = pb.id;
  }
  const { data: playbook } = await db().from("onboarding_playbook").select("id, name, offeringId, targetDays").eq("id", playbookId).maybeSingle();
  if (!playbook) return { ok: false, error: "That playbook no longer exists." };
  const { data: steps } = await db().from("onboarding_playbook_step").select("*").eq("playbookId", playbookId).order("sortOrder");

  const { data: number, error: numErr } = await db().rpc("next_sequence_number", { p_entity_type: SEQUENCES.ONBOARDING });
  if (numErr) return { ok: false, error: numErr.message };
  const start = today();
  const account = flat(opp.account) as { name: string } | null;
  const manager = opp.ownerUserId as string | null;
  const { data: onb, error } = await db().from("onboarding").insert({
    onboardingNumber: number, accountId: opp.accountId, opportunityId, playbookId, offeringId: opp.offeringId ?? playbook.offeringId,
    name: `${account?.name ?? "Customer"} - ${playbook.name}`, managerUserId: manager, startDate: start,
    targetGoLive: playbook.targetDays ? addDays(start, playbook.targetDays) : null, createdById: options.actor.id,
  }).select("id").single();
  if (error) return { ok: false, error: error.message };

  const rows = (steps ?? []).map((s) => ({
    onboardingId: onb.id, phase: s.phase, title: s.title, instructions: s.instructions,
    ownerUserId: s.ownerKind === "USER" ? s.ownerUserId : manager, dueDate: addDays(start, s.dueDays),
    stepType: s.stepType, requiresNote: s.requiresNote, waitsForPrevious: s.waitsForPrevious, isGoLive: s.isGoLive, sortOrder: s.sortOrder,
  }));
  if (rows.length) {
    const { error: stepErr } = await db().from("onboarding_step").insert(rows);
    if (stepErr) {
      await db().from("onboarding").delete().eq("id", onb.id);
      return { ok: false, error: stepErr.message };
    }
  }
  await audit(onb.id, "started", null, playbook.name, options.actor.id);

  // Everyone with a step hears about it once.
  const owners = [...new Set(rows.map((r) => r.ownerUserId).filter(Boolean))] as string[];
  for (const u of owners) {
    if (u === options.actor.id) continue;
    await notify(u, `Onboarding started: ${account?.name ?? "new customer"}`, `You have ${rows.filter((r) => r.ownerUserId === u).length} step(s) in ${number}.`, `/onboarding/${onb.id}`, onb.id);
  }
  refresh(onb.id, opportunityId);
  return { ok: true, id: onb.id };
}

