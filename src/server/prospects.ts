"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requireUser, can } from "@/lib/authz";
import { describeInvalid } from "@/lib/form-errors";
import { normalizeEmail, normalizeName, normalizePhone, normalizeWebsite } from "@/lib/prospect-normalize";
import type { ActionResult } from "./partners";

/**
 * Prospecting: marketing's raw prospect lists, brought over from ORMS.
 *
 * A prospect is a business on a list (a dataset) with any number of phones,
 * emails and people. Lists run to hundreds of thousands, so nothing here loads
 * a whole table: the list is paged in the database (prospect_page) and its
 * figures are counted there (prospect_stats), both from one filter definition
 * (prospect_filtered) so they always agree. Row-level security decides access
 * by the prospect:* permissions.
 */

import { PROSPECT_PAGE_SIZE as PAGE_SIZE } from "@/lib/prospects";

export interface ProspectFilters {
  search?: string;
  datasetId?: string;
  status?: string;
  icpTier?: string;
  region?: string;
  tag?: string;
}

const FILTER_KEYS = ["search", "datasetId", "status", "icpTier", "region", "tag"] as const;
const filterPayload = (f?: ProspectFilters) =>
  Object.fromEntries(FILTER_KEYS.filter((k) => f?.[k]).map((k) => [k, f![k]]));

async function requireProspectRead() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) {
    throw new Error("You do not have access to prospects.");
  }
  return me;
}

export interface ProspectRow {
  id: string;
  businessName: string;
  website: string | null;
  industry: string | null;
  region: string | null;
  icpTier: string | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  tags: string[];
  status: string;
  createdAt: string;
  phone: string | null;
  email: string | null;
  phoneCount: number;
  emailCount: number;
  dataset: string | null;
}

export async function listProspects(filters?: ProspectFilters, page = 0): Promise<ProspectRow[]> {
  await requireProspectRead();
  const db = await supabaseServer();
  const { data, error } = await db.rpc("prospect_page", { p_filters: filterPayload(filters), p_limit: PAGE_SIZE, p_offset: Math.max(0, page) * PAGE_SIZE });
  if (error) throw new Error(`Could not load prospects: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  const datasetIds = [...new Set(rows.map((r) => r.datasetId).filter(Boolean))] as string[];
  const [phones, emails, datasets] = await Promise.all([
    db.from("prospect_phone").select("prospectId, phone, isPrimary").in("prospectId", ids),
    db.from("prospect_email").select("prospectId, email, isPrimary").in("prospectId", ids),
    datasetIds.length ? db.from("prospect_dataset").select("id, name").in("id", datasetIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const first = <T extends { prospectId: string; isPrimary: boolean }>(list: T[] | null, id: string) => {
    const mine = (list ?? []).filter((x) => x.prospectId === id);
    return { pick: mine.find((x) => x.isPrimary) ?? mine[0], count: mine.length };
  };
  const datasetName = new Map((datasets.data ?? []).map((d) => [d.id, d.name]));
  return rows.map((r) => {
    const p = first(phones.data as { prospectId: string; phone: string; isPrimary: boolean }[], String(r.id));
    const e = first(emails.data as { prospectId: string; email: string; isPrimary: boolean }[], String(r.id));
    return {
      id: String(r.id),
      businessName: String(r.businessName),
      website: (r.website as string) ?? null,
      industry: (r.industry as string) ?? null,
      region: (r.region as string) ?? null,
      icpTier: (r.icpTier as string) ?? null,
      googleRating: r.googleRating == null ? null : Number(r.googleRating),
      googleReviewCount: r.googleReviewCount == null ? null : Number(r.googleReviewCount),
      tags: (r.tags as string[]) ?? [],
      status: String(r.status),
      createdAt: String(r.createdAt),
      phone: p.pick?.phone ?? null,
      email: e.pick?.email ?? null,
      phoneCount: p.count,
      emailCount: e.count,
      dataset: r.datasetId ? datasetName.get(String(r.datasetId)) ?? null : null,
    };
  });
}

export interface ProspectStats {
  total: number;
  withPhone: number;
  withEmail: number;
  withWebsite: number;
  qualified: number;
  byIcpTier: { value: string; count: number }[];
  byRegion: { value: string; count: number }[];
}

export async function getProspectStats(filters?: ProspectFilters): Promise<ProspectStats> {
  await requireProspectRead();
  const db = await supabaseServer();
  const { data, error } = await db.rpc("prospect_stats", { p_filters: filterPayload(filters) });
  if (error) throw new Error(`Could not count prospects: ${error.message}`);
  return data as ProspectStats;
}

export async function getProspectFilterValues(): Promise<{ icpTiers: string[]; regions: string[]; tags: string[] }> {
  await requireProspectRead();
  const db = await supabaseServer();
  const { data } = await db.rpc("prospect_filter_values");
  return (data as { icpTiers: string[]; regions: string[]; tags: string[] }) ?? { icpTiers: [], regions: [], tags: [] };
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export async function listDatasets() {
  await requireProspectRead();
  const db = await supabaseServer();
  const { data, error } = await db.from("prospect_dataset").select("id, name, description, createdAt, createdBy:app_user ( fullName )").is("deletedAt", null).order("createdAt", { ascending: false });
  if (error) throw new Error(`Could not load datasets: ${error.message}`);
  const counted = await Promise.all((data ?? []).map(async (d) => {
    const [all, active, qualified] = await Promise.all([
      db.from("prospect").select("id", { count: "exact", head: true }).eq("datasetId", d.id).is("deletedAt", null),
      db.from("prospect").select("id", { count: "exact", head: true }).eq("datasetId", d.id).eq("status", "ACTIVE").is("deletedAt", null),
      db.from("prospect").select("id", { count: "exact", head: true }).eq("datasetId", d.id).eq("status", "QUALIFIED").is("deletedAt", null),
    ]);
    const by = Array.isArray(d.createdBy) ? d.createdBy[0] : d.createdBy;
    return { id: d.id, name: d.name, description: d.description, createdAt: d.createdAt, createdBy: (by as { fullName?: string } | null)?.fullName ?? null, total: all.count ?? 0, active: active.count ?? 0, qualified: qualified.count ?? 0 };
  }));
  return counted;
}

const datasetSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional().nullable() });

export async function saveDataset(id: string | null, input: z.input<typeof datasetSchema>): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = datasetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const db = await supabaseServer();
  const row = { name: parsed.data.name, description: parsed.data.description || null, updatedAt: new Date().toISOString() };
  const result = id
    ? await db.from("prospect_dataset").update(row).eq("id", id).select("id").single()
    : await db.from("prospect_dataset").insert({ ...row, createdById: auth.user.id }).select("id").single();
  if (result.error) {
    return { ok: false, error: /duplicate|unique/i.test(result.error.message) ? "A dataset with that name already exists." : result.error.message };
  }
  revalidatePath("/prospects/datasets");
  return { ok: true, data: { id: result.data.id } };
}

/** Removes an empty dataset. One that still holds prospects is refused. */
export async function deleteDataset(id: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const db = await supabaseServer();
  const { count } = await db.from("prospect").select("id", { count: "exact", head: true }).eq("datasetId", id).is("deletedAt", null);
  if (count) return { ok: false, error: `It still holds ${count} prospects. Move or remove them first.` };
  const { error } = await db.from("prospect_dataset").update({ deletedAt: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/prospects/datasets");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// One prospect
// ---------------------------------------------------------------------------

export async function getProspect(id: string) {
  await requireProspectRead();
  const db = await supabaseServer();
  const { data, error } = await db
    .from("prospect")
    .select(`*, dataset:prospect_dataset ( id, name ), owner:app_user!prospect_ownerUserId_fkey ( id, fullName ),
      qualifiedLead:lead ( id, leadNumber, firstName, lastName ),
      phones:prospect_phone ( id, phone, label, "phoneClass", "phoneType", "isPrimary" ),
      emails:prospect_email ( id, email, "isPrimary" ),
      people:prospect_person ( id, name, role, email, phone, "personalEmail", "personalPhone", "linkedinUrl", "isPrimary", notes )`)
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load the prospect: ${error.message}`);
  }
  if (!data) return null;
  const one = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] ?? null : v);
  return {
    ...data,
    dataset: one(data.dataset) as { id: string; name: string } | null,
    owner: one(data.owner) as { id: string; fullName: string } | null,
    qualifiedLead: one(data.qualifiedLead) as { id: string; leadNumber: string; firstName: string; lastName: string } | null,
    phones: ((data.phones ?? []) as { id: string; phone: string; label: string | null; phoneClass: string | null; phoneType: string | null; isPrimary: boolean }[]).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    emails: ((data.emails ?? []) as { id: string; email: string; isPrimary: boolean }[]).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    people: ((data.people ?? []) as PersonInput[] & { id: string }[]).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
  };
}

const optional = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);

const prospectSchema = z.object({
  businessName: z.string().trim().min(1).max(300),
  website: optional(500),
  industry: optional(150),
  street: optional(300),
  city: optional(120),
  region: optional(150),
  country: optional(100),
  icpTier: optional(60),
  googleRating: z.coerce.number().min(0).max(5).optional().nullable().or(z.literal("").transform(() => null)),
  googleReviewCount: z.coerce.number().int().min(0).optional().nullable().or(z.literal("").transform(() => null)),
  googleMapsUrl: optional(2000),
  datasetId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  customFields: z.record(z.string(), z.string().max(5000)).optional(),
});

export async function updateProspect(id: string, input: z.input<typeof prospectSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = prospectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const d = parsed.data;
  const db = await supabaseServer();
  const { error } = await db.from("prospect").update({
    ...d,
    customFields: d.customFields ?? undefined,
    nameNorm: normalizeName(d.businessName),
    websiteNorm: normalizeWebsite(d.website),
    updatedAt: new Date().toISOString(),
  }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/prospects/${id}`);
  return { ok: true, data: undefined };
}

/** Adds and removes tags on many prospects at once. */
export async function tagProspects(ids: string[], add: string[], remove: string[] = []): Promise<ActionResult<{ changed: number }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const clean = (list: string[]) => [...new Set(list.map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 60)))];
  const adding = clean(add), removing = clean(remove);
  if (!ids.length || (!adding.length && !removing.length)) return { ok: false, error: "Choose prospects and a tag." };
  const db = await supabaseServer();
  let changed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db.from("prospect").select("id, tags").in("id", ids.slice(i, i + 500));
    if (error) return { ok: false, error: error.message };
    for (const p of data ?? []) {
      const next = [...new Set([...(p.tags as string[]).filter((t) => !removing.includes(t)), ...adding])];
      if (next.join("\u0000") === (p.tags as string[]).join("\u0000")) continue;
      const { error: e } = await db.from("prospect").update({ tags: next, updatedAt: new Date().toISOString() }).eq("id", p.id);
      if (!e) changed++;
    }
  }
  revalidatePath("/prospects");
  return { ok: true, data: { changed } };
}

// Phones, emails and people ------------------------------------------------

export async function addProspectPhone(prospectId: string, phone: string, label?: string | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const value = phone.trim();
  if (!value) return { ok: false, error: "Phone is required." };
  const db = await supabaseServer();
  const { count } = await db.from("prospect_phone").select("id", { count: "exact", head: true }).eq("prospectId", prospectId);
  const { error } = await db.from("prospect_phone").insert({ prospectId, phone: value.slice(0, 60), phoneNorm: normalizePhone(value), label: label?.trim() || null, isPrimary: !count });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: undefined };
}

export async function addProspectEmail(prospectId: string, email: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = z.string().trim().email("Email: enter a valid email address.").safeParse(email);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const db = await supabaseServer();
  const { count } = await db.from("prospect_email").select("id", { count: "exact", head: true }).eq("prospectId", prospectId);
  const { error } = await db.from("prospect_email").insert({ prospectId, email: parsed.data, emailNorm: normalizeEmail(parsed.data), isPrimary: !count });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: undefined };
}

/** Removes a phone, email or person, or makes one the primary. */
export async function changeProspectDetail(
  kind: "phone" | "email" | "person",
  id: string,
  action: "remove" | "primary",
): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const table = kind === "phone" ? "prospect_phone" : kind === "email" ? "prospect_email" : "prospect_person";
  const db = await supabaseServer();
  const { data: row } = await db.from(table).select("prospectId").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "It no longer exists." };
  if (action === "remove") {
    const { error } = await db.from(table).delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    await db.from(table).update({ isPrimary: false }).eq("prospectId", row.prospectId);
    const { error } = await db.from(table).update({ isPrimary: true }).eq("id", id);
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath(`/prospects/${row.prospectId}`);
  return { ok: true, data: undefined };
}

const personSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: optional(120),
  email: z.string().trim().email().max(320).optional().nullable().or(z.literal("").transform(() => null)),
  phone: optional(60),
  personalEmail: z.string().trim().email().max(320).optional().nullable().or(z.literal("").transform(() => null)),
  personalPhone: optional(60),
  linkedinUrl: optional(500),
  isPrimary: z.boolean().optional(),
  notes: optional(4000),
});
type PersonInput = z.input<typeof personSchema>;

export async function saveProspectPerson(prospectId: string, personId: string | null, input: PersonInput): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = personSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const db = await supabaseServer();
  const row = { ...parsed.data, isPrimary: parsed.data.isPrimary ?? false, updatedAt: new Date().toISOString() };
  if (row.isPrimary) await db.from("prospect_person").update({ isPrimary: false }).eq("prospectId", prospectId);
  const { error } = personId
    ? await db.from("prospect_person").update(row).eq("id", personId).eq("prospectId", prospectId)
    : await db.from("prospect_person").insert({ ...row, prospectId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const importRowSchema = z.object({
  businessName: z.string().trim().min(1).max(300),
  website: z.string().trim().max(500).optional().nullable(),
  industry: z.string().trim().max(150).optional().nullable(),
  street: z.string().trim().max(300).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  region: z.string().trim().max(150).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  icpTier: z.string().trim().max(60).optional().nullable(),
  googleRating: z.number().min(0).max(5).optional().nullable(),
  googleReviewCount: z.number().int().min(0).optional().nullable(),
  googleMapsUrl: z.string().trim().max(2000).optional().nullable(),
  phones: z.array(z.string().trim().max(60)).max(20).default([]),
  emails: z.array(z.string().trim().max(320)).max(20).default([]),
  tags: z.array(z.string().trim().max(60)).max(20).default([]),
  customFields: z.record(z.string(), z.string().max(5000)).default({}),
});
export type ProspectImportRow = z.input<typeof importRowSchema>;

const importSchema = z.object({
  datasetId: z.string().uuid(),
  source: z.string().max(300).optional().nullable(),
  /** What makes two rows the same business. */
  matchOn: z.array(z.enum(["website", "phone", "email", "name"])).default(["website", "phone", "email"]),
  /** What to do with a row matching a prospect already on file. */
  duplicates: z.enum(["skip", "update"]).default("skip"),
  rows: z.array(importRowSchema).min(1).max(1000),
});

export interface ImportBatchResult { imported: number; updated: number; skipped: number; invalid: number; errors: string[] }

/**
 * Imports one batch of rows already read from the sheet in the browser. The
 * screen sends the file in batches, so a file of any size goes through without
 * one request carrying all of it.
 */
export async function importProspectBatch(input: z.input<typeof importSchema>): Promise<ActionResult<ImportBatchResult>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_WRITE);
  if (!auth.ok) return auth;
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error) };
  const { datasetId, source, matchOn, duplicates, rows } = parsed.data;
  const db = await supabaseServer();
  const result: ImportBatchResult = { imported: 0, updated: 0, skipped: 0, invalid: 0, errors: [] };

  // Normalise each row once.
  const prepared = rows.map((r) => {
    // [normalised, as written], one per number or address.
    const phones = [...new Map<string, string>(
      r.phones.map((p): [string, string] => [normalizePhone(p) ?? "", p]).filter(([n]) => n.length >= 6),
    ).entries()];
    const emails = [...new Map<string, string>(
      r.emails.map((e): [string, string] => [normalizeEmail(e) ?? "", e]).filter(([n]) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(n)),
    ).entries()];
    return { r, nameNorm: normalizeName(r.businessName), websiteNorm: normalizeWebsite(r.website), phones, emails };
  });

  // What is already on file, matched by the chosen keys, in a handful of queries.
  const existing = new Map<string, string>();
  const lookup = async (table: string, column: string, values: string[], key: (v: string) => string) => {
    for (let i = 0; i < values.length; i += 300) {
      const chunk = values.slice(i, i + 300);
      if (!chunk.length) continue;
      const select = table === "prospect" ? `id, ${column}` : `prospectId, ${column}`;
      let q = db.from(table).select(select).in(column, chunk);
      if (table === "prospect") q = q.is("deletedAt", null);
      const { data } = await q;
      for (const row of (data ?? []) as unknown as Record<string, string>[]) existing.set(key(row[column]), row.id ?? row.prospectId);
    }
  };
  if (matchOn.includes("website")) await lookup("prospect", "websiteNorm", [...new Set(prepared.map((p) => p.websiteNorm).filter(Boolean) as string[])], (v) => `w:${v}`);
  if (matchOn.includes("name")) await lookup("prospect", "nameNorm", [...new Set(prepared.map((p) => p.nameNorm).filter(Boolean) as string[])], (v) => `n:${v}`);
  if (matchOn.includes("phone")) await lookup("prospect_phone", "phoneNorm", [...new Set(prepared.flatMap((p) => p.phones.map(([n]) => n)))], (v) => `p:${v}`);
  if (matchOn.includes("email")) await lookup("prospect_email", "emailNorm", [...new Set(prepared.flatMap((p) => p.emails.map(([n]) => n)))], (v) => `e:${v}`);

  const keysOf = (p: (typeof prepared)[number]) => [
    ...(matchOn.includes("website") && p.websiteNorm ? [`w:${p.websiteNorm}`] : []),
    ...(matchOn.includes("name") && p.nameNorm ? [`n:${p.nameNorm}`] : []),
    ...(matchOn.includes("phone") ? p.phones.map(([n]) => `p:${n}`) : []),
    ...(matchOn.includes("email") ? p.emails.map(([n]) => `e:${n}`) : []),
  ];

  const now = new Date().toISOString();
  const toInsert: { id: string; p: (typeof prepared)[number] }[] = [];
  for (const p of prepared) {
    const keys = keysOf(p);
    const match = keys.map((k) => existing.get(k)).find(Boolean);
    if (match) {
      if (duplicates === "skip") { result.skipped++; continue; }
      const r = p.r;
      const { data: current } = await db.from("prospect").select("tags, customFields").eq("id", match).maybeSingle();
      const { error } = await db.from("prospect").update({
        businessName: r.businessName, nameNorm: p.nameNorm,
        ...(r.website ? { website: r.website, websiteNorm: p.websiteNorm } : {}),
        ...Object.fromEntries((["industry", "street", "city", "region", "country", "icpTier", "googleRating", "googleReviewCount", "googleMapsUrl"] as const).filter((k) => r[k] != null && r[k] !== "").map((k) => [k, r[k]])),
        tags: [...new Set([...((current?.tags as string[]) ?? []), ...r.tags])],
        customFields: { ...((current?.customFields as Record<string, string>) ?? {}), ...r.customFields },
        updatedAt: now,
      }).eq("id", match);
      if (error) { result.errors.push(`${r.businessName}: ${error.message}`); continue; }
      const { data: had } = await db.from("prospect_phone").select("phoneNorm").eq("prospectId", match);
      const hadPhones = new Set((had ?? []).map((x) => x.phoneNorm));
      const newPhones = p.phones.filter(([n]) => !hadPhones.has(n)).map(([n, raw]) => ({ prospectId: match, phone: raw, phoneNorm: n, isPrimary: false }));
      if (newPhones.length) await db.from("prospect_phone").insert(newPhones);
      const { data: hadE } = await db.from("prospect_email").select("emailNorm").eq("prospectId", match);
      const hadEmails = new Set((hadE ?? []).map((x) => x.emailNorm));
      const newEmails = p.emails.filter(([n]) => !hadEmails.has(n)).map(([n, raw]) => ({ prospectId: match, email: raw, emailNorm: n, isPrimary: false }));
      if (newEmails.length) await db.from("prospect_email").insert(newEmails);
      result.updated++;
      continue;
    }
    const id = crypto.randomUUID();
    toInsert.push({ id, p });
    // A later row in the same batch matching this one is a duplicate too.
    for (const k of keys) existing.set(k, id);
  }

  if (toInsert.length) {
    const { error } = await db.from("prospect").insert(toInsert.map(({ id, p }) => ({
      id, businessName: p.r.businessName, nameNorm: p.nameNorm, website: p.r.website || null, websiteNorm: p.websiteNorm,
      industry: p.r.industry || null, street: p.r.street || null, city: p.r.city || null, region: p.r.region || null, country: p.r.country || null,
      icpTier: p.r.icpTier || null, googleRating: p.r.googleRating ?? null, googleReviewCount: p.r.googleReviewCount ?? null, googleMapsUrl: p.r.googleMapsUrl || null,
      tags: [...new Set(p.r.tags.filter(Boolean))], customFields: p.r.customFields, datasetId, source: source || null,
      createdById: auth.user.id, ownerUserId: auth.user.id, updatedAt: now,
    })));
    if (error) return { ok: false, error: `Could not save this batch: ${error.message}` };
    const phones = toInsert.flatMap(({ id, p }) => p.phones.map(([n, raw], i) => ({ prospectId: id, phone: raw, phoneNorm: n, isPrimary: i === 0 })));
    const emails = toInsert.flatMap(({ id, p }) => p.emails.map(([n, raw], i) => ({ prospectId: id, email: raw, emailNorm: n, isPrimary: i === 0 })));
    if (phones.length) { const { error: e } = await db.from("prospect_phone").insert(phones); if (e) result.errors.push(`Phones: ${e.message}`); }
    if (emails.length) { const { error: e } = await db.from("prospect_email").insert(emails); if (e) result.errors.push(`Emails: ${e.message}`); }
    result.imported = toInsert.length;
  }
  return { ok: true, data: result };
}
