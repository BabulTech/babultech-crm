"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { requireUser, AuthorizationError } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { sanitizeRichText } from "@/lib/rich-text";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionResult } from "./partners";

/**
 * What a partner sells: BabulTech's Products & Services, read-only, and their
 * own company's, which they add and edit here. Another partner's items are
 * never shown (20260928000006, 20260928000007).
 *
 * Reads go through the partner's session. Writes are partner_save_product,
 * which checks the item is the partner company's first. Price books are ours
 * and are only ever read.
 */

async function requirePartner() {
  const user = await requireUser();
  if (!user.partnerId) throw new AuthorizationError("This account is not a partner portal login.");
  return user;
}

/** The partner's company, which owns their items. An individual partner has none. */
async function partnerCompany(db: SupabaseClient, partnerId: string): Promise<string | null> {
  const { data } = await db.from("partner").select("accountId").eq("id", partnerId).maybeSingle();
  return (data?.accountId as string | null) ?? null;
}

/** BabulTech's items and the partner's own: what they may sell. */
async function catalogueIds(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db.rpc("app_partner_catalogue_ids");
  const ids = (Array.isArray(data) ? data : []).map((row: unknown) =>
    typeof row === "string" ? row : (Object.values((row ?? {}) as Record<string, string>)[0] ?? null),
  );
  return new Set(ids.filter((id): id is string => Boolean(id)));
}

export interface PartnerCatalogueItem {
  id: string;
  productCode: string;
  name: string;
  productType: "PRODUCT" | "SERVICE";
  addInTask: boolean;
  active: boolean;
  /** The partner company's own, which they may edit; otherwise BabulTech's. */
  mine: boolean;
}

export interface PartnerCatalogue {
  items: PartnerCatalogueItem[];
  /** Whether the partner has a company to own items - an individual partner does not. */
  canAddItems: boolean;
}

export async function listPartnerCatalogue(filters?: {
  search?: string;
  whose?: "mine" | "ours" | "";
  productType?: string;
}): Promise<PartnerCatalogue> {
  const user = await requirePartner();
  const db = await supabaseServer();

  const [company, sellable, { data, error }] = await Promise.all([
    partnerCompany(db, user.partnerId!),
    catalogueIds(db),
    db.from("product")
      .select("id, productCode, name, productType, addInTask, active, ownerAccountId")
      .is("deletedAt", null)
      .order("productCode"),
  ]);
  if (error) throw new Error(`Could not load the catalogue: ${error.message}`);

  const q = filters?.search?.trim().toLowerCase() ?? "";
  const items = (data ?? [])
    // What they may read also includes items our team put on their deals;
    // the catalogue is only what they may sell.
    .filter((p) => sellable.has(p.id as string))
    .map((p) => ({
      id: p.id as string,
      productCode: p.productCode as string,
      name: p.name as string,
      productType: p.productType as PartnerCatalogueItem["productType"],
      addInTask: Boolean(p.addInTask),
      active: Boolean(p.active),
      mine: company != null && p.ownerAccountId === company,
    }))
    // BabulTech's retired items cannot be sold, so they are not offered; the
    // partner's own stay listed, so they can be switched back on.
    .filter((p) => p.mine || p.active)
    .filter((p) => (filters?.whose === "mine" ? p.mine : filters?.whose === "ours" ? !p.mine : true))
    .filter((p) => !filters?.productType || p.productType === filters.productType)
    .filter((p) => !q || `${p.name} ${p.productCode}`.toLowerCase().includes(q));

  return { items, canAddItems: company != null };
}

export interface PartnerItem extends PartnerCatalogueItem {
  description: string | null;
  createdAt: string;
  /** Its prices in our books, where it is in any. */
  prices: { bookId: string; bookName: string; quantity: string; rate: string; total: string }[];
  /** Priced in a book or sold on a deal, which locks its type. */
  typeLocked: boolean;
}

export async function getPartnerItem(id: string): Promise<PartnerItem | null> {
  const user = await requirePartner();
  const db = await supabaseServer();

  const [company, sellable, { data: p }] = await Promise.all([
    partnerCompany(db, user.partnerId!),
    catalogueIds(db),
    db.from("product")
      .select("id, productCode, name, productType, addInTask, active, ownerAccountId, description, createdAt")
      .eq("id", id)
      .is("deletedAt", null)
      .maybeSingle(),
  ]);
  if (!p || !sellable.has(p.id as string)) return null;

  const [{ data: entries }, { count: sold }] = await Promise.all([
    db.from("price_book_entry")
      .select(
        `quantity, rate, licenseCost, maintenanceCost, cloudCost, aiCost,
         book:price_book!inner ( id, name, active, deletedAt )`,
      )
      .eq("productId", id)
      .eq("active", true)
      .is("deletedAt", null)
      .is("book.deletedAt", null),
    db.from("opportunity_product").select("id", { count: "exact", head: true }).eq("productId", id),
  ]);

  const prices = (entries ?? [])
    .map((e) => {
      const book = one(e.book as never) as unknown as { id: string; name: string; active: boolean };
      const total =
        Number(e.quantity) * Number(e.rate) +
        Number(e.licenseCost) + Number(e.maintenanceCost) + Number(e.cloudCost) + Number(e.aiCost);
      return {
        bookId: book.id,
        bookName: book.name,
        bookActive: Boolean(book.active),
        quantity: String(e.quantity),
        rate: String(e.rate),
        total: total.toFixed(2),
      };
    })
    .filter((x) => x.bookActive)
    .map(({ bookActive: _active, ...rest }) => rest);

  return {
    id: p.id as string,
    productCode: p.productCode as string,
    name: p.name as string,
    productType: p.productType as PartnerItem["productType"],
    addInTask: Boolean(p.addInTask),
    active: Boolean(p.active),
    mine: company != null && p.ownerAccountId === company,
    description: (p.description as string | null) ?? null,
    createdAt: p.createdAt as string,
    prices,
    typeLocked: prices.length > 0 || (sold ?? 0) > 0,
  };
}

const itemSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1, "Give it a name.").max(200, "That name is too long."),
  productType: z.enum(["PRODUCT", "SERVICE"], { message: "Choose Product or Service." }),
  addInTask: z.coerce.boolean().default(false),
  active: z.coerce.boolean().default(true),
  description: z.string().max(20000).optional().nullable(),
});

/** Add one of the partner company's own items (no id), or edit one. */
export async function savePartnerItem(
  input: z.infer<typeof itemSchema> & { ownerAccountId?: string | null },
): Promise<ActionResult<{ id: string }>> {
  try {
    await requirePartner();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const { data, error } = await db.rpc("partner_save_product", {
    p_id: d.id ?? null,
    p_product: {
      name: d.name,
      productType: d.productType,
      addInTask: d.productType === "SERVICE" && d.addInTask,
      active: d.active,
      description: d.description ? sanitizeRichText(d.description) : null,
    },
  });
  if (error) {
    // The type lock speaks for itself; everything else is passed through.
    return {
      ok: false,
      error: error.message,
      fieldErrors: error.code === "23514" && /priced or sold/.test(error.message) ? { productType: [error.message] } : undefined,
    };
  }

  const id = (data as { id: string }).id;
  revalidatePath("/portal/catalogue");
  revalidatePath(`/portal/catalogue/${id}`);
  return { ok: true, data: { id } };
}
