"use server";

import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { z } from "zod";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { authorize, requireUser, PERMISSIONS } from "@/lib/authz";
import type { Picklist, PicklistMap } from "@/lib/picklists";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Every list's active values, for the forms.
 *
 * One small query for the whole app, loaded in the layout. A failure returns an
 * empty map rather than throwing: the forms fall back to their built-in values,
 * which is better than a broken page.
 *
 * Cached across requests: the layout reads it on every navigation and it
 * changes only when an administrator edits a list, which clears the tag below.
 * Read with the service client because a cached function cannot see the
 * request's cookies; the values are the same for every internal user, and the
 * caller is still required to be signed in.
 */
const PICKLIST_TAG = "picklists";

const loadPicklistMap = unstable_cache(
  async (): Promise<PicklistMap> => {
    const { data, error } = await supabaseAdmin()
      .from("picklist_value")
      .select("picklistKey, value, label, sortOrder")
      .eq("active", true)
      .order("sortOrder")
      .order("label");
    // Thrown so a failed read is not cached as an empty map.
    if (error) throw error;

    const map: PicklistMap = {};
    for (const row of data ?? []) {
      (map[row.picklistKey] ??= []).push({ value: row.value, label: row.label });
    }
    return map;
  },
  ["picklist-map"],
  { tags: [PICKLIST_TAG], revalidate: 300 },
);

export async function getPicklistMap(): Promise<PicklistMap> {
  await requireUser();
  return loadPicklistMap().catch(() => ({}));
}

/** Every list with every value, hidden ones included, for Settings. */
export async function getPicklistsForAdmin(): Promise<Picklist[]> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return [];
  const db = await supabaseServer();

  const [lists, values] = await Promise.all([
    db.from("picklist").select("*").order("sortOrder"),
    db.from("picklist_value").select("*").order("sortOrder").order("label"),
  ]);
  if (lists.error || values.error) return [];

  return (lists.data ?? []).map((l) => ({
    key: l.key,
    label: l.label,
    groupName: l.groupName,
    enumType: l.enumType,
    locked: l.locked,
    description: l.description,
    values: (values.data ?? [])
      .filter((v) => v.picklistKey === l.key)
      .map((v) => ({
        id: v.id,
        value: v.value,
        label: v.label,
        sortOrder: v.sortOrder,
        active: v.active,
      })),
  }));
}

function done(): Result {
  // Every form reads these, so every page is stale.
  revalidatePath("/", "layout");
  return { ok: true };
}

const addSchema = z.object({
  list: z.string().min(1),
  label: z.string().trim().min(1, "Give the value a name.").max(100, "That name is too long."),
});

/**
  * Adds a value to an open list, from Settings or from any form that uses it.
  *
  * Deliberately not admin-only: the person filling in a lead is the one who
  * knows the source it came from, and sending them away to have it added is how
  * "Other" ends up meaning six different things. The database refuses workflow
  * lists at any permission level, and only someone who may write records at all
  * gets this far.
  */
export async function addPicklistValue(
  list: string,
  label: string,
): Promise<{ ok: true; value: { value: string; label: string } } | { ok: false; error: string }> {
  // No permission argument: add_picklist_value applies the write check itself,
  // against the caller's own session.
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = addSchema.safeParse({ list, label });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the value." };

  const db = await supabaseServer();
  const { data, error } = await db.rpc("add_picklist_value", {
    p_list: parsed.data.list,
    p_value: parsed.data.label,
    p_label: parsed.data.label,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/", "layout");
  return { ok: true, value: { value: String(data.value), label: String(data.label) } };
}

const updateSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "Give the value a name.").max(100, "That name is too long.").optional(),
  active: z.boolean().optional(),
});

/** Rename or hide/show a value. Works on locked lists too. */
export async function updatePicklistValue(
  id: string,
  patch: { label?: string; active?: boolean },
): Promise<Result> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = updateSchema.safeParse({ id, ...patch });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the value." };

  const { id: rowId, ...values } = parsed.data;
  const db = await supabaseServer();
  const { error } = await db
    .from("picklist_value")
    .update({ ...values, updatedAt: new Date().toISOString() })
    .eq("id", rowId);
  if (error) return { ok: false, error: error.message };
  return done();
}

/** Moves a value one place up or down within its list. */
export async function movePicklistValue(id: string, direction: "up" | "down"): Promise<Result> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { data: row } = await db.from("picklist_value").select("picklistKey").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "That value no longer exists." };

  const { data: siblings, error } = await db
    .from("picklist_value")
    .select("id")
    .eq("picklistKey", row.picklistKey)
    .order("sortOrder")
    .order("label");
  if (error) return { ok: false, error: error.message };

  const ids = (siblings ?? []).map((s) => s.id as string);
  const from = ids.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return { ok: true };
  [ids[from], ids[to]] = [ids[to], ids[from]];

  // Renumber the whole list so equal sort orders from the seed cannot tie.
  const now = new Date().toISOString();
  const results = await Promise.all(
    ids.map((rowId, i) => db.from("picklist_value").update({ sortOrder: (i + 1) * 10, updatedAt: now }).eq("id", rowId)),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) return { ok: false, error: failed.error.message };
  return done();
}

export async function deletePicklistValue(id: string): Promise<Result> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { error } = await db.rpc("delete_picklist_value", { p_id: id });
  if (error) return { ok: false, error: error.message };
  return done();
}
