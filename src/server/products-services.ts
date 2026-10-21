"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { applySearch, LIST_LIMIT } from "@/lib/db";
import { one } from "@/lib/decimal";
import { sanitizeRichText } from "@/lib/rich-text";
import type { ActionResult } from "./partners";

/**
 * Products & Services: everything we, and our partners, sell.
 *
 * Named "product" in the database and "Products & Services" everywhere a person
 * reads it. Renaming the table would have touched every foreign key and query
 * that names it - and a renamed relationship is exactly the fault that has taken
 * the login page down before - for a change nobody would see.
 *
 * Deliberately small: a name, a system-issued code, whether it is a Product or a
 * Service, whether it is active, a description and an owner. Prices live in
 * price books, not here.
 *
 * The one rule that matters downstream is Add in Task. A SERVICE flagged with it
 * is sold in HOURS, and those hours become a project task when a deal is won.
 * The database refuses the flag on a product, and locks the type once the item
 * is priced or sold, because re-classifying it then would re-classify history.
 */

export interface ProductService {
  id: string;
  productCode: string;
  name: string;
  productType: "PRODUCT" | "SERVICE";
  addInTask: boolean;
  active: boolean;
  description: string | null;
  ownerAccountId: string | null;
  owner?: { id: string; name: string } | null;
  createdAt: string;
}

const SELECT = `
  id, productCode, name, productType, addInTask, active, description,
  ownerAccountId, createdAt,
  owner:account!product_ownerAccountId_fkey ( id, name )
`;

export async function listProductsServices(filters?: {
  search?: string;
  productType?: string;
  active?: string;
}): Promise<ProductService[]> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  let query = db
    .from("product")
    .select(SELECT)
    .is("deletedAt", null)
    .order("productCode");

  if (filters?.productType) query = query.eq("productType", filters.productType);
  if (filters?.active === "yes") query = query.eq("active", true);
  if (filters?.active === "no") query = query.eq("active", false);
  query = applySearch(query, filters?.search, ["name", "productCode"]);

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load products and services: ${error.message}`);

  return (data ?? []).map((p) => ({ ...p, owner: one(p.owner as never) })) as unknown as ProductService[];
}

export async function getProductService(id: string): Promise<
  | (ProductService & {
      /** Where it is priced, so the page can say so. */
      prices: { bookId: string; bookName: string; bookActive: boolean; quantity: string; rate: string; total: string }[];
      /** Whether it has been sold or priced - which is what locks its type. */
      typeLocked: boolean;
    })
  | null
> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  const { data: p } = await db
    .from("product")
    .select(SELECT)
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (!p) return null;

  const [{ data: entries }, { count: sold }] = await Promise.all([
    db
      .from("price_book_entry")
      .select(
        `quantity, rate, licenseCost, maintenanceCost, cloudCost, aiCost,
         book:price_book!inner ( id, name, active, deletedAt )`,
      )
      .eq("productId", id)
      .is("deletedAt", null)
      .is("book.deletedAt", null),
    db
      .from("opportunity_product")
      .select("id", { count: "exact", head: true })
      .eq("productId", id),
  ]);

  const prices = (entries ?? []).map((e) => {
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
  });

  return {
    ...(p as unknown as ProductService),
    owner: one(p.owner as never),
    prices,
    typeLocked: prices.length > 0 || (sold ?? 0) > 0,
  };
}

const schema = z.object({
  id: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1, "Give it a name.").max(200, "That name is too long."),
  productType: z.enum(["PRODUCT", "SERVICE"], { message: "Choose Product or Service." }),
  addInTask: z.coerce.boolean().default(false),
  active: z.coerce.boolean().default(true),
  description: z.string().max(20000).optional().nullable(),
  ownerAccountId: z.string().uuid().optional().nullable().or(z.literal("")),
});

export async function saveProductService(
  input: z.infer<typeof schema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const row = {
    name: d.name,
    productType: d.productType,
    // Only a service can carry it. The database refuses it on a product too;
    // clearing it here means switching a draft to Product does not fail on a
    // leftover tick.
    addInTask: d.productType === "SERVICE" ? d.addInTask : false,
    active: d.active,
    description: d.description ? sanitizeRichText(d.description) : null,
    // Blank means "us": the database fills in the company's own account.
    ownerAccountId: d.ownerAccountId || null,
    updatedAt: new Date().toISOString(),
  };

  const db = await supabaseServer();

  // The code is issued by the database whatever is sent, so a placeholder is
  // enough to satisfy the column on insert.
  const { data, error } = d.id
    ? await db.from("product").update(row).eq("id", d.id).select("id").maybeSingle()
    : await db.from("product").insert({ productCode: "pending", ...row }).select("id").single();

  if (error) {
    // The type lock speaks for itself; everything else is passed through.
    return { ok: false, error: error.message, fieldErrors: error.code === "23514" ? { productType: [error.message] } : undefined };
  }
  if (!data) return { ok: false, error: "That product or service no longer exists." };

  revalidatePath("/products");
  revalidatePath(`/products/${data.id}`);
  return { ok: true, data: { id: data.id as string } };
}

export async function setProductServiceActive(id: string, active: boolean): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { error } = await db
    .from("product")
    .update({ active, updatedAt: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
  return { ok: true, data: undefined };
}
