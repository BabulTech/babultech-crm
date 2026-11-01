import { NextResponse, type NextRequest } from "next/server";
import { listActivity } from "@/server/activity-log";

const EXPORT_LIMIT = 10_000;

// A leading = + - @ is a formula to a spreadsheet; the quote keeps it as text.
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const get = (k: string) => p.get(k) ?? undefined;
  const { rows } = await listActivity(
    { q: get("q"), category: get("category"), outcome: get("outcome"), actor: get("actor"), from: get("from"), to: get("to") },
    1,
    EXPORT_LIMIT,
  );
  const lines = [
    ["When (UTC)", "Type", "Action", "Result", "Who", "What happened", "Record type", "Record id", "Error"].map(cell).join(","),
    ...rows.map((r) => [r.occurredAt, r.category, r.action, r.outcome, r.actorName, r.summary, r.entityType, r.entityId, r.detail?.error].map(cell).join(",")),
  ];
  return new NextResponse(`﻿${lines.join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
