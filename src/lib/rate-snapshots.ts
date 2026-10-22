import { requireUser, can, PERMISSIONS } from "./authz";
import { supabaseAdmin, supabaseServer } from "./supabase";

export const MEMBER_PUBLIC_COLUMNS = "id,projectId,userId,projectRole,allocationPercent,startDate,endDate,active,createdAt,updatedAt";
export const TIME_PUBLIC_COLUMNS = "id,userId,projectId,projectTaskId,caseId,workDate,hours,description,billable,approvalStatus,approvedById,approvedAt,invoiceLineId,createdAt,updatedAt,startTime,endTime";

/** Server-only enrichment: verify row visibility again before privileged reads. */
export async function withRateSnapshots<T extends { id: string }>(
  table: "project_member" | "time_log", rows: T[], mode: "financial" | "billing" = "financial",
): Promise<Array<T & { costRate: string | null; billingRate: string | null }>> {
  const user = await requireUser();
  const financial = can(user, PERMISSIONS.PROJECT_RATES_READ);
  const permitted = financial || (mode === "billing" && can(user, PERMISSIONS.INVOICE_WRITE));
  const empty = rows.map((row) => ({ ...row, costRate: null, billingRate: null }));
  if (!permitted || !rows.length || user.partnerId) return empty;
  const db = await supabaseServer();
  const rates = new Map<string, { costRate: string | null; billingRate: string | null }>();
  const admin = supabaseAdmin();
  const chunks: string[][] = [];
  for (let offset = 0; offset < rows.length; offset += 250) {
    chunks.push(rows.slice(offset, offset + 250).map((row) => row.id));
  }
  // Chunks side by side: a project with a few thousand entries was paying two
  // round trips per 250 rows, one after another. Within a chunk the order
  // stays - the caller's own client says which rows they may see before the
  // service client reads rates for those rows only.
  const results = await Promise.all(chunks.map(async (ids) => {
    const visible = await db.from(table).select("id").in("id", ids);
    if (visible.error) throw new Error("Could not verify financial record access.");
    if (!visible.data?.length) return [];
    const result = await admin.from(table).select("id,costRate,billingRate")
      .in("id", visible.data.map((row) => row.id));
    if (result.error) throw new Error("Could not load authorized rate snapshots.");
    return result.data ?? [];
  }));
  for (const row of results.flat()) rates.set(row.id, {
    costRate: financial && row.costRate != null ? String(row.costRate) : null,
    billingRate: row.billingRate != null ? String(row.billingRate) : null,
  });
  return rows.map((row) => ({ ...row, ...(rates.get(row.id) ?? { costRate: null, billingRate: null }) }));
}
