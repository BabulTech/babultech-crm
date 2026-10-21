"use server";

import { deleteToRecycleBin } from "./recycle-bin";
import { describeInvalid } from "@/lib/form-errors";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission, requireUser, canAny, AuthorizationError } from "@/lib/authz";
import { one } from "@/lib/decimal";
import type { ActionResult } from "./partners";

/**
 * Price books: our prices for a period, for everything we sell.
 *
 * A book is a catalogue - "2026 Standard Rates" - and each entry prices one
 * product or service in it. An opportunity chooses ONE book and then picks its
 * products from it, which is what this shape makes possible; under the old
 * shape each product carried its own books and there was no single book to
 * choose.
 *
 * Lines COPY an entry's figures when they are added, so revising or retiring a
 * book never re-prices a deal that was already priced from it.
 */

export interface PriceBook {
  id: string;
  name: string;
  description: string | null;
  currencyCode: string;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  entryCount: number;
}

export interface PriceBookEntry {
  id: string;
  priceBookId: string;
  productId: string;
  quantity: string;
  rate: string;
  licenseCost: string;
  maintenanceCost: string;
  cloudCost: string;
  aiCost: string;
  active: boolean;
  product: {
    id: string;
    name: string;
    productCode: string;
    productType: "PRODUCT" | "SERVICE";
    addInTask: boolean;
  } | null;
}

const money = z.preprocess(
  (v) => (v === "" || v == null ? 0 : v),
  z.coerce.number().finite().min(0, "Amounts cannot be negative."),
);
const optionalDate = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.string().date().nullable(),
);

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export async function listPriceBooks(filters?: { activeOnly?: boolean }): Promise<PriceBook[]> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  let query = db
    .from("price_book")
    .select(
      `id, name, description, currencyCode, validFrom, validTo, active,
       entries:price_book_entry ( count )`,
    )
    .is("deletedAt", null)
    .order("active", { ascending: false })
    .order("name");

  if (filters?.activeOnly) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load price books: ${error.message}`);

  return (data ?? []).map((b) => ({
    id: b.id as string,
    name: b.name as string,
    description: (b.description as string) ?? null,
    currencyCode: b.currencyCode as string,
    validFrom: (b.validFrom as string) ?? null,
    validTo: (b.validTo as string) ?? null,
    active: Boolean(b.active),
    entryCount: (b.entries as { count: number }[] | undefined)?.[0]?.count ?? 0,
  }));
}

export async function getPriceBook(id: string): Promise<(PriceBook & { entries: PriceBookEntry[] }) | null> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  const { data: book } = await db
    .from("price_book")
    .select("id, name, description, currencyCode, validFrom, validTo, active")
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (!book) return null;

  const entries = await listPriceBookEntries(id);

  return {
    id: book.id as string,
    name: book.name as string,
    description: (book.description as string) ?? null,
    currencyCode: book.currencyCode as string,
    validFrom: (book.validFrom as string) ?? null,
    validTo: (book.validTo as string) ?? null,
    active: Boolean(book.active),
    entryCount: entries.length,
    entries,
  };
}

const bookSchema = z
  .object({
    id: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1, "Give the price book a name.").max(100, "That name is too long."),
    description: z.string().trim().max(2000).optional().nullable(),
    currencyCode: z.string().length(3).default("PKR"),
    validFrom: optionalDate,
    validTo: optionalDate,
    active: z.boolean().default(true),
  })
  .refine((v) => !v.validFrom || !v.validTo || v.validTo >= v.validFrom, {
    path: ["validTo"],
    message: "Must be on or after the start date.",
  });

export async function savePriceBook(
  input: z.infer<typeof bookSchema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = bookSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id, ...row } = parsed.data;
  const db = await supabaseServer();

  const payload = { ...row, description: row.description || null, updatedAt: new Date().toISOString() };
  const { data, error } = id
    ? await db.from("price_book").update(payload).eq("id", id).select("id").maybeSingle()
    : await db.from("price_book").insert(payload).select("id").single();

  if (error) {
    // The unique index is on the name; say it in words.
    if (error.code === "23505") {
      return { ok: false, error: "A price book with that name already exists.", fieldErrors: { name: ["Already in use."] } };
    }
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: "That price book no longer exists." };

  revalidatePath("/price-books");
  revalidatePath(`/price-books/${data.id}`);
  return { ok: true, data: { id: data.id as string } };
}

/**
 * Copy a book, with every price in it - how next year's rates are started.
 *
 * Copying rather than editing is the point: the old book stays exactly as it
 * was, so deals priced from it still show where their numbers came from.
 */
export async function copyPriceBook(
  sourceId: string,
  name: string,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Give the new price book a name." };

  const db = await supabaseServer();
  const source = await getPriceBook(sourceId);
  if (!source) return { ok: false, error: "That price book no longer exists." };

  const { data: created, error } = await db
    .from("price_book")
    .insert({
      name: trimmed,
      description: source.description,
      currencyCode: source.currencyCode,
      active: false,
      updatedAt: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { ok: false, error: "A price book with that name already exists." };
    return { ok: false, error: error.message };
  }

  if (source.entries.length) {
    const { error: entryError } = await db.from("price_book_entry").insert(
      source.entries.map((e) => ({
        priceBookId: created.id,
        productId: e.productId,
        quantity: e.quantity,
        rate: e.rate,
        licenseCost: e.licenseCost,
        maintenanceCost: e.maintenanceCost,
        cloudCost: e.cloudCost,
        aiCost: e.aiCost,
        active: e.active,
      })),
    );
    if (entryError) return { ok: false, error: entryError.message };
  }

  revalidatePath("/price-books");
  return { ok: true, data: { id: created.id as string } };
}

/** Only the Super Admin deletes; this is the recycle bin's delete, kept for its callers. */
export async function deletePriceBook(id: string, reason?: string | null): Promise<ActionResult> {
  return deleteToRecycleBin("PriceBook", id, reason) as never;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const ENTRY_SELECT = `
  id, priceBookId, productId, quantity, rate,
  licenseCost, maintenanceCost, cloudCost, aiCost, active,
  product ( id, name, productCode, productType, addInTask )
`;

export async function listPriceBookEntries(priceBookId: string): Promise<PriceBookEntry[]> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("price_book_entry")
    .select(ENTRY_SELECT)
    .eq("priceBookId", priceBookId)
    .is("deletedAt", null);

  if (error) throw new Error(`Could not load prices: ${error.message}`);

  return (data ?? [])
    .map((e) => ({ ...e, product: one(e.product as never) }))
    .sort((a, b) =>
      String((a.product as { productCode?: string } | null)?.productCode ?? "").localeCompare(
        String((b.product as { productCode?: string } | null)?.productCode ?? ""),
      ),
    ) as unknown as PriceBookEntry[];
}

const entrySchema = z.object({
  id: z.string().uuid().optional().nullable(),
  priceBookId: z.string().uuid(),
  productId: z.string().uuid("Choose a product or service."),
  quantity: money,
  rate: money,
  licenseCost: money,
  maintenanceCost: money,
  cloudCost: money,
  aiCost: money,
  active: z.boolean().default(true),
});

export async function savePriceBookEntry(
  input: z.infer<typeof entrySchema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = entrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id, ...row } = parsed.data;
  const db = await supabaseServer();

  const payload = { ...row, updatedAt: new Date().toISOString() };
  const { data, error } = id
    ? await db.from("price_book_entry").update(payload).eq("id", id).select("id").maybeSingle()
    : await db.from("price_book_entry").insert(payload).select("id").single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That product or service is already priced in this book. Edit its existing price instead." };
    }
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: "That price no longer exists." };

  revalidatePath(`/price-books/${row.priceBookId}`);
  return { ok: true, data: { id: data.id as string } };
}

export async function deletePriceBookEntry(id: string, priceBookId: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const db = await supabaseServer();
  const { error } = await db
    .from("price_book_entry")
    .update({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/price-books/${priceBookId}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// For quotes and invoices
// ---------------------------------------------------------------------------

/**
 * Active products and services, with the books that price them.
 *
 * Quotes and invoices read this shape - a product and a list of priced offers -
 * so it is kept, now built from book entries. An item in no book can still be
 * put on a line; its price is then typed in.
 */
export async function listCatalogueProducts(): Promise<
  {
    id: string;
    name: string;
    productCode: string;
    defaultTaxRateId: string | null;
    priceBooks: { id: string; name: string; total: string }[];
  }[]
> {
  // Deals and invoices are both priced from the catalogue, so either reader may list it.
  const me = await requireUser();
  if (!canAny(me, PERMISSIONS.OPPORTUNITY_READ, PERMISSIONS.INVOICE_READ)) {
    throw new AuthorizationError(`Missing permission: ${PERMISSIONS.OPPORTUNITY_READ}`);
  }
  const db = await supabaseServer();

  const [products, entries] = await Promise.all([
    db
      .from("product")
      .select("id, name, productCode, defaultTaxRateId")
      .is("deletedAt", null)
      .eq("active", true)
      .order("productCode"),
    db
      .from("price_book_entry")
      .select(
        `productId, quantity, rate, licenseCost, maintenanceCost, cloudCost, aiCost,
         book:price_book!inner ( id, name, active, deletedAt )`,
      )
      .is("deletedAt", null)
      .eq("active", true)
      .eq("book.active", true)
      .is("book.deletedAt", null),
  ]);

  const byProduct = new Map<string, { id: string; name: string; total: string }[]>();
  for (const e of entries.data ?? []) {
    const book = one(e.book as never) as { id: string; name: string } | null;
    if (!book) continue;
    const total =
      Number(e.quantity) * Number(e.rate) +
      Number(e.licenseCost) + Number(e.maintenanceCost) + Number(e.cloudCost) + Number(e.aiCost);
    const list = byProduct.get(e.productId as string) ?? [];
    list.push({ id: book.id, name: book.name, total: total.toFixed(2) });
    byProduct.set(e.productId as string, list);
  }

  return (products.data ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    productCode: p.productCode as string,
    defaultTaxRateId: (p.defaultTaxRateId as string | null) ?? null,
    priceBooks: byProduct.get(p.id as string) ?? [],
  }));
}
