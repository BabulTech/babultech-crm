import { NextResponse, type NextRequest } from "next/server";
import { getCompanyOverview, getOverviewExtras } from "@/server/company-overview";
import { period, RANGES } from "../period";

const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** The period's figures, previous period and cash outlook, for owner reviews. */
export async function GET(request: NextRequest) {
  const range = request.nextUrl.searchParams.get("range") ?? "this-month";
  const { from, to } = period(RANGES.some((r) => r.key === range) ? range : "this-month");
  const [o, x] = await Promise.all([getCompanyOverview(from, to), getOverviewExtras()]);
  const rows: unknown[][] = [["Section", "Measure", `${from} to ${to}`, "Previous period"]];
  for (const [key, value] of Object.entries(o.current)) rows.push(["Headline", key, value, o.previous[key]]);
  for (const [key, value] of Object.entries(o.money)) if (typeof value === "number") rows.push(["Money", key, value, ""]);
  for (const [key, value] of Object.entries(x.cash)) rows.push(["Cash next 30 days", key, value, ""]);
  for (const t of x.trends) rows.push(["Trend", t.month, `invoiced ${t.invoiced}; collected ${t.collected}; new pipeline ${t.newPipeline}`, ""]);
  return new NextResponse(`﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="company-overview-${from}-to-${to}.csv"` },
  });
}
