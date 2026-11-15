"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { authorize, requireUser, PERMISSIONS } from "@/lib/authz";
import type { ActionResult } from "./partners";

/**
 * Offerings: what kind of sale a deal is (Web development, BabulPOS...). Each
 * one carries its own proposal templates and onboarding playbooks.
 */

const db = () => supabaseAdmin();

export interface Offering { id: string; name: string; description: string | null; active: boolean; sortOrder: number }

export async function listOfferings(includeHidden = false): Promise<Offering[]> {
  await requireUser();
  let q = db().from("offering").select("id, name, description, active, sortOrder").order("sortOrder").order("name");
  if (!includeHidden) q = q.eq("active", true);
  const { data } = await q;
  return (data ?? []) as Offering[];
}

const schema = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(100),
  description: z.string().trim().max(1000).nullable().optional(),
});

export async function createOffering(input: { name: string; description?: string | null; channel?: string | null }): Promise<ActionResult<{ id: string; name: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the name." };
  const { data: clash } = await db().from("offering").select("id, name, active").ilike("name", parsed.data.name).maybeSingle();
  if (clash) {
    if (!clash.active) {
      await db().from("offering").update({ active: true, updatedAt: new Date().toISOString() }).eq("id", clash.id);
      revalidatePath("/offerings");
      return { ok: true, data: { id: clash.id, name: clash.name } };
    }
    return { ok: false, error: `"${clash.name}" already exists.` };
  }
  const { data, error } = await db().from("offering").insert({ name: parsed.data.name, description: parsed.data.description ?? null, sortOrder: 50 }).select("id, name").single();
  if (error) return { ok: false, error: error.message };
  revalidatePath("/offerings");
  return { ok: true, data };
}

export async function updateOffering(id: string, input: { name?: string; description?: string | null; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Give it a name." };
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.active !== undefined) patch.active = input.active;
  const { error } = await db().from("offering").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message.includes("offering_name_key") ? "Another offering has that name." : error.message };
  revalidatePath("/offerings");
  return { ok: true, data: { id } };
}

/** Sets what a deal is for. Anyone who can edit deals. */
export async function setOpportunityOffering(opportunityId: string, offeringId: string | null): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return auth;
  const { data: opp } = await db().from("opportunity").select("id, offeringId").eq("id", opportunityId).maybeSingle();
  if (!opp) return { ok: false, error: "That opportunity no longer exists." };
  if ((opp.offeringId ?? null) === (offeringId ?? null)) return { ok: true, data: { id: opportunityId } };
  const { error } = await db().from("opportunity").update({ offeringId, updatedAt: new Date().toISOString() }).eq("id", opportunityId);
  if (error) return { ok: false, error: error.message };
  const names = new Map(((await db().from("offering").select("id, name")).data ?? []).map((o) => [o.id, o.name as string]));
  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "Opportunity", entityId: opportunityId, fieldName: "offering",
    oldValue: opp.offeringId ? names.get(opp.offeringId) ?? null : null, newValue: offeringId ? names.get(offeringId) ?? null : null,
    changedById: auth.user.id, source: "UI", changedAt: new Date().toISOString(),
  });
  revalidatePath(`/opportunities/${opportunityId}`);
  return { ok: true, data: { id: opportunityId } };
}
