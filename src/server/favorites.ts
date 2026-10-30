"use server";

import { supabaseServer } from "@/lib/supabase";
import { authorize, requireUser } from "@/lib/authz";
import { getViewAs } from "@/lib/view-as";
import { RECORD_PATHS, RECORD_TYPE_LABEL } from "@/lib/record-paths";
import type { ActionResult } from "./partners";

/**
 * Favourite records: each person's own short list, shown in the search box and
 * on My work. Our team only - portal logins have no favourites.
 */

export interface FavoriteRecord {
  href: string;
  label: string;
  type: string;
  entityType: string;
  entityId: string;
}

export async function isFavorite(entityType: string, entityId: string): Promise<boolean | null> {
  try {
    const me = await requireUser();
    if (me.userType !== "INTERNAL" || !RECORD_PATHS[entityType]) return null;
    const db = await supabaseServer();
    const { data } = await db.from("favorite_record").select("entityId").eq("entityType", entityType).eq("entityId", entityId).maybeSingle();
    return Boolean(data);
  } catch {
    return null;
  }
}

export async function setFavorite(entityType: string, entityId: string, label: string, on: boolean): Promise<ActionResult<{ favorite: boolean }>> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (auth.user.userType !== "INTERNAL") return { ok: false, error: "Favourites are for our team." };
  if (!RECORD_PATHS[entityType]) return { ok: false, error: "That kind of record cannot be a favourite." };
  if (await getViewAs()) return { ok: false, error: "View as is read-only." };
  const db = await supabaseServer();
  const result = on
    ? await db.from("favorite_record").upsert({ entityType, entityId, label: label.trim().slice(0, 300) || "Untitled" }, { onConflict: "userId,entityType,entityId" })
    : await db.from("favorite_record").delete().eq("entityType", entityType).eq("entityId", entityId);
  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true, data: { favorite: on } };
}

export async function listFavorites(limit = 30): Promise<FavoriteRecord[]> {
  try {
    const me = await requireUser();
    if (me.userType !== "INTERNAL") return [];
  } catch {
    return [];
  }
  const db = await supabaseServer();
  const { data } = await db
    .from("favorite_record")
    .select("entityType, entityId, label")
    .order("createdAt", { ascending: false })
    .limit(Math.min(limit, 100));
  return (data ?? [])
    .filter((r) => RECORD_PATHS[r.entityType as string])
    .map((r) => ({
      href: `${RECORD_PATHS[r.entityType as string]}${r.entityId}`,
      label: r.label as string,
      type: RECORD_TYPE_LABEL[r.entityType as string] ?? (r.entityType as string),
      entityType: r.entityType as string,
      entityId: r.entityId as string,
    }));
}

// ---------------------------------------------------------------------------
// Favourite screens and actions
// ---------------------------------------------------------------------------

export interface FavoriteLink { id: string; kind: "SCREEN" | "ACTION"; href: string; label: string }
export interface Shortcuts { links: FavoriteLink[]; records: FavoriteRecord[] }

/** Null for portal logins, who have no favourites. */
export async function listShortcuts(): Promise<Shortcuts | null> {
  try {
    const me = await requireUser();
    if (me.userType !== "INTERNAL") return null;
    const db = await supabaseServer();
    const [{ data }, records] = await Promise.all([
      db.from("favorite_link").select("id, kind, href, label").order("position").order("createdAt"),
      listFavorites(30),
    ]);
    return { links: (data ?? []) as FavoriteLink[], records };
  } catch {
    return null;
  }
}

async function mayChange(): Promise<ActionResult | null> {
  const auth = await authorize();
  if (!auth.ok) return { ok: false, error: auth.error };
  if (auth.user.userType !== "INTERNAL") return { ok: false, error: "Favourites are for our team." };
  if (await getViewAs()) return { ok: false, error: "View as is read-only." };
  return null;
}

export async function toggleShortcut(kind: "SCREEN" | "ACTION", href: string, label: string, on: boolean): Promise<ActionResult> {
  const refused = await mayChange();
  if (refused) return refused;
  if (!href.startsWith("/") || href.startsWith("//") || href.length > 1000) return { ok: false, error: "That cannot be a favourite." };
  const db = await supabaseServer();
  if (!on) {
    const { error } = await db.from("favorite_link").delete().eq("href", href);
    return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
  }
  const { data: last } = await db.from("favorite_link").select("position").order("position", { ascending: false }).limit(1).maybeSingle();
  const { error } = await db.from("favorite_link").upsert(
    { kind, href, label: label.trim().slice(0, 120) || "Untitled", position: Number(last?.position ?? 0) + 1 },
    { onConflict: "userId,href" },
  );
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

export async function renameShortcut(id: string, label: string): Promise<ActionResult> {
  const refused = await mayChange();
  if (refused) return refused;
  const name = label.trim().slice(0, 120);
  if (!name) return { ok: false, error: "Give it a name." };
  const { error } = await (await supabaseServer()).from("favorite_link").update({ label: name }).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true, data: undefined };
}

/** Moves a favourite one place up or down, renumbering the whole list. */
export async function moveShortcut(id: string, direction: -1 | 1): Promise<ActionResult> {
  const refused = await mayChange();
  if (refused) return refused;
  const db = await supabaseServer();
  const { data } = await db.from("favorite_link").select("id").order("position").order("createdAt");
  const ids = (data ?? []).map((r) => r.id as string);
  const i = ids.indexOf(id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= ids.length) return { ok: true, data: undefined };
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await Promise.all(ids.map((rowId, position) => db.from("favorite_link").update({ position }).eq("id", rowId)));
  return { ok: true, data: undefined };
}
