"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { authorize, requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getViewAs } from "@/lib/view-as";
import type { ActionResult } from "./partners";

/**
 * Saved list views: a name for a list's filters. See the saved views
 * migration for the idea.
 */

const LISTS = [
  "leads", "accounts", "contacts", "opportunities", "cases", "activities",
  "campaigns", "campaign-members", "projects", "invoices",
] as const;
export type ListName = (typeof LISTS)[number];

export interface SavedView {
  id: string;
  name: string;
  query: string;
  isDefault: boolean;
  shared: boolean;
  mine: boolean;
}

export async function listSavedViews(entity: ListName): Promise<SavedView[]> {
  const user = await requireUser();
  const db = await supabaseServer();
  const { data } = await db
    .from("saved_view")
    .select("id, userId, name, query, isDefault, shared")
    .eq("entity", entity)
    .order("name");
  return (data ?? []).map((v) => ({
    id: v.id as string,
    name: v.name as string,
    query: v.query as string,
    isDefault: Boolean(v.isDefault) && v.userId === user.id,
    shared: Boolean(v.shared),
    mine: v.userId === user.id,
  }));
}

/**
 * Opens a person's default view when they arrive at a list with no filters.
 * `?all=1` - the "All records" link - shows the unfiltered list instead.
 */
export async function applyDefaultView(entity: ListName, params: Record<string, unknown>): Promise<void> {
  if (Object.values(params).some((v) => v !== undefined && v !== "")) return;
  if (await getViewAs()) return;
  // Read with the profile in requireUser(), so this costs no round trip.
  const query = (await requireUser()).defaultViews?.[entity];
  if (query) redirect(`/${entity}?${query}`);
}

/** The filters worth keeping from a list's address: never paging or "all". */
function cleanQuery(query: string): string {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  for (const key of ["page", "all", "sent", "queued"]) params.delete(key);
  return params.toString();
}

const saveSchema = z.object({
  entity: z.enum(LISTS),
  name: z.string().trim().min(1, "Give the view a name.").max(120),
  query: z.string().max(2000),
  isDefault: z.boolean(),
  shared: z.boolean(),
});

export async function saveView(input: z.infer<typeof saveSchema>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That view could not be saved." };
  const d = parsed.data;
  if (d.shared && !can(auth.user, PERMISSIONS.ADMIN)) return { ok: false, error: "Only an administrator can share a view with everyone." };
  const query = cleanQuery(d.query);
  if (!query) return { ok: false, error: "Filter the list first; a view with no filters is the whole list." };

  const db = await supabaseServer();
  if (d.isDefault) {
    await db.from("saved_view").update({ isDefault: false }).eq("userId", auth.user.id).eq("entity", d.entity).eq("isDefault", true);
  }
  const { data, error } = await db
    .from("saved_view")
    .insert({ userId: auth.user.id, entity: d.entity, name: d.name, query, isDefault: d.isDefault, shared: d.shared })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "That view could not be saved." };
  revalidatePath(`/${d.entity}`);
  return { ok: true, data: { id: data.id as string } };
}

export async function setDefaultView(entity: ListName, id: string | null): Promise<ActionResult> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!LISTS.includes(entity)) return { ok: false, error: "That list has no views." };
  const db = await supabaseServer();
  await db.from("saved_view").update({ isDefault: false }).eq("userId", auth.user.id).eq("entity", entity).eq("isDefault", true);
  if (id) {
    // A shared view becomes someone's default by keeping their own copy of it.
    const { data: view } = await db.from("saved_view").select("userId, name, query").eq("id", id).maybeSingle();
    if (!view) return { ok: false, error: "That view could not be found." };
    if (view.userId === auth.user.id) {
      const { error } = await db.from("saved_view").update({ isDefault: true, updatedAt: new Date().toISOString() }).eq("id", id);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await db.from("saved_view").insert({
        userId: auth.user.id, entity, name: view.name, query: view.query, isDefault: true, shared: false,
      });
      if (error) return { ok: false, error: error.message };
    }
  }
  revalidatePath(`/${entity}`);
  return { ok: true, data: undefined };
}

export async function deleteView(id: string): Promise<ActionResult> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  const db = await supabaseServer();
  const { data, error } = await db.from("saved_view").delete().eq("id", id).eq("userId", auth.user.id).select("entity");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Only whoever saved a view can delete it." };
  revalidatePath(`/${data[0].entity}`);
  return { ok: true, data: undefined };
}
