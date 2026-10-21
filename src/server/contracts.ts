"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { createRecord, updateRecord } from "@/lib/db";
import { SEQUENCES } from "@/lib/numbering";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { editGate, markCorrectionSaved } from "./corrections";
import type { ActionResult } from "./partners";

/**
 * Contracts (spec §10.2). A contract is normally the accepted quote turned
 * into a term — so `createContract` can seed itself from a quotation and keeps
 * the link, which is also how commission finds its way from a project invoice
 * back to the originating opportunity.
 */

const contractSchema = z.object({
  name: z.string().min(1).max(255),
  accountId: z.string().uuid(),
  opportunityId: z.string().uuid().optional().nullable(),
  quotationId: z.string().uuid().optional().nullable(),
  ownerUserId: z.string().uuid(),
  contractType: z.string().min(1).max(100),
  status: z
    .enum(["DRAFT", "UNDER_REVIEW", "SENT_FOR_SIGNATURE", "ACTIVE", "EXPIRED", "TERMINATED", "RENEWED"])
    .default("DRAFT"),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  contractValue: z.coerce.number().min(0),
  currencyCode: z.string().length(3).default("PKR"),
  billingFrequency: z.enum(["ONE_TIME", "MONTHLY", "QUARTERLY", "MILESTONE", "ANNUAL"]).optional().nullable(),
  renewalType: z.enum(["MANUAL", "AUTO_RENEW"]).optional().nullable(),
  noticePeriodDays: z.coerce.number().int().min(0).optional().nullable(),
  signedDate: z.coerce.date().optional().nullable(),
  terminationReason: z.string().optional().nullable(),
});

function validate(data: z.infer<typeof contractSchema>): ActionResult<never> | null {
  if (data.endDate < data.startDate) {
    return {
      ok: false,
      error: "A contract cannot end before it starts.",
      fieldErrors: { endDate: ["Must be on or after the start date."] },
    };
  }
  if (data.status === "ACTIVE" && !data.signedDate) {
    return {
      ok: false,
      error: "An active contract needs a signature date - otherwise nothing says the customer agreed.",
      fieldErrors: { signedDate: ["Required before a contract can go active."] },
    };
  }
  if (data.status === "TERMINATED" && !data.terminationReason) {
    return {
      ok: false,
      error: "Record why the contract was terminated.",
      fieldErrors: { terminationReason: ["A reason is required."] },
    };
  }
  return null;
}

export async function createContract(
  input: z.infer<typeof contractSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.CONTRACT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = contractSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const invalid = validate(parsed.data);
  if (invalid) return invalid;

  try {
    const contract = await createRecord<{ id: string }>(
      "contract",
      {
        ...parsed.data,
        startDate: parsed.data.startDate.toISOString().slice(0, 10),
        endDate: parsed.data.endDate.toISOString().slice(0, 10),
      },
      { field: "contractNumber", sequence: SEQUENCES.CONTRACT },
    );

    revalidatePath("/contracts");
    return { ok: true, data: { id: contract.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the contract." };
  }
}

export async function updateContract(
  id: string,
  input: z.infer<typeof contractSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.CONTRACT_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const user = _auth.user;

  const parsed = contractSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const invalid = validate(parsed.data);
  if (invalid) return invalid;

  const gate = await editGate("Contract", id);
  if (!gate.ok) return { ok: false, error: gate.error };

  try {
    const db = await supabaseServer();

    // Terminating a contract while projects still run under it would orphan
    // them, so the check comes before the write rather than inside it.
    if (parsed.data.status === "TERMINATED") {
      const { count: live } = await db
        .from("project")
        .select("id", { count: "exact", head: true })
        .eq("contractId", id)
        .in("status", ["PLANNING", "ACTIVE", "AT_RISK"]);

      if ((live ?? 0) > 0) {
        return {
          ok: false,
          error: `${live} project(s) are still running under this contract. Close them before terminating it.`,
        };
      }
    }

    await updateRecord(
      "contract",
      id,
      {
        ...parsed.data,
        startDate: parsed.data.startDate.toISOString().slice(0, 10),
        endDate: parsed.data.endDate.toISOString().slice(0, 10),
      },
      "Contract",
      user.id,
    );
    await markCorrectionSaved(gate.correctionId);

    revalidatePath("/contracts");
    revalidatePath(`/contracts/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the contract." };
  }
}

export async function getContract(id: string) {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);
  const db = await supabaseServer();
  const { data } = await db.from("contract").select("*").eq("id", id).maybeSingle();
  return data;
}

export async function getContractFormOptions() {
  await requirePermission(PERMISSIONS.OPPORTUNITY_READ);

  const db = await supabaseServer();

  const [accountsRes, usersRes, opportunitiesRes, quotationsRes, currenciesRes] =
    await Promise.all([
      db.from("account").select("id, name").is("deletedAt", null).order("name"),
      db
        .from("app_user")
        .select("id, fullName")
        .eq("status", "ACTIVE")
        .is("deletedAt", null)
        .order("fullName"),
      db
        .from("opportunity")
        .select("id, opportunityNumber, name, accountId")
        .is("deletedAt", null)
        .order("name"),
      db
        .from("quotation")
        .select(
          "id, quoteNumber, versionNumber, accountId, opportunityId, totalAmount, currencyCode",
        )
        .is("deletedAt", null)
        .eq("status", "ACCEPTED")
        .order("quoteNumber"),
      db.from("currency").select("*").eq("active", true).order("code"),
    ]);

  const accounts = accountsRes.data ?? [];
  const users = usersRes.data ?? [];
  const opportunities = opportunitiesRes.data ?? [];
  const quotations = quotationsRes.data ?? [];
  const currencies = currenciesRes.data ?? [];

  return { accounts, users, opportunities, quotations, currencies };
}
