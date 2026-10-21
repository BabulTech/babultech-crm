"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { loadOpportunityPricing, type OpportunityPricing } from "@/lib/opportunity-pricing";
import { dealLinesSchema, type DealLinesInput } from "@/lib/priced-input";
import type { ActionResult } from "./partners";

/**
 * A deal's products and services.
 *
 * The lines are what the deal IS now: their total is the deal's amount, and the
 * service lines flagged Add in Task become the delivery project's tasks when it
 * is won. Everything here reads or writes those lines; the arithmetic itself
 * lives in the database, as generated columns, so a line's total can never
 * disagree with its own fields.
 */

export type {
  OpportunityLine, PricingOption, BookEntryPrice, OpportunityPricing,
} from "@/lib/opportunity-pricing";

export async function getOpportunityPricing(opportunityId: string): Promise<OpportunityPricing | null> {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  return loadOpportunityPricing(await supabaseServer(), opportunityId);
}

export async function saveOpportunityLines(
  input: DealLinesInput,
): Promise<ActionResult<{ amount: string; lines: number }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = dealLinesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  if (d.lines.length > 0 && !d.priceBookId) {
    return { ok: false, error: "Choose the price book this deal is priced from." };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("save_opportunity_lines", {
    p_opportunity: d.opportunityId,
    p_price_book: d.priceBookId || null,
    p_lines: d.lines.map((l) => ({
      ...l,
      id: l.id ?? null,
      priceBookEntryId: l.priceBookEntryId ?? null,
      taxRateId: l.taxRateId || null,
    })),
  });

  if (error) return { ok: false, error: error.message };

  const result = data as { amount: number; lines: number };

  revalidatePath(`/opportunities/${d.opportunityId}`);
  revalidatePath("/opportunities");
  return { ok: true, data: { amount: String(result.amount), lines: result.lines } };
}
