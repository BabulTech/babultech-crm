import { supabaseServer } from "./supabase";

/**
 * Human-readable record numbers (spec §1.1: "separate unique fields generated
 * by controlled sequences").
 *
 * The allocation itself lives in the database — `next_sequence_number()` in
 * supabase/functions-sql/009_fn_numbering.sql — because it must happen in the same
 * transaction as the insert it numbers. Allocating here and inserting in a
 * separate HTTP call would burn a number whenever the insert failed.
 *
 * Prefer `createRecord(table, payload, { field, sequence })` from lib/db, which
 * does both in one call. Use this directly only when a number is needed without
 * an immediate insert.
 */
export async function nextNumber(entityType: string): Promise<string> {
  const db = await supabaseServer();

  const { data, error } = await db.rpc("next_sequence_number", {
    p_entity_type: entityType,
  });

  if (error) throw new Error(error.message);
  return data as string;
}

export const SEQUENCES = {
  LEAD: "Lead",
  ACCOUNT: "Account",
  OPPORTUNITY: "Opportunity",
  QUOTATION: "Quotation",
  CONTRACT: "Contract",
  CASE: "Case",
  PROJECT: "Project",
  INVOICE: "Invoice",
  PAYMENT: "Payment",
  EXPENSE: "Expense",
  ASSET: "Asset",
  VENDOR_BILL: "VendorBill",
  VENDOR_PAYMENT: "VendorPayment",
  CAMPAIGN: "Campaign",
  ARTICLE: "KnowledgeArticle",
  CHANGE_REQUEST: "ChangeRequest",
  TRANSACTION: "FinancialTransaction",
  PARTNER: "Partner",
  STAFF: "StaffProfile",
  EMPLOYMENT_CONTRACT: "EmploymentContract",
} as const;
