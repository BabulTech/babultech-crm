import { Coins, Receipt, CalendarRange, Tag, User } from "lucide-react";
import { getExpenseAnalytics, type Grain } from "@/server/expense-analytics";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { resolveRange } from "@/lib/date-range";
import { PageHeader, Card, CardContent, StatTile, Forbidden, Alert, EmptyState } from "@/components/ui";
import { formatMoneyTotal } from "@/lib/utils";
import { DateRangeFilter } from "../../date-range-filter";
import { AnalyticsFilters } from "./analytics-filters";
import { ExpenseChart } from "./expense-chart";

type Params = Record<string, string | string[] | undefined>;
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Grain picked from the range unless chosen: days for a month, weeks for a quarter, months beyond. */
function autoGrain(from: string | null, to: string | null): Grain {
  if (!from || !to) return "month";
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days <= 45 ? "day" : days <= 180 ? "week" : "month";
}

export default async function ExpenseAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.EXPENSE_READ)) return <Forbidden what="expenses" />;
  const p = await searchParams;
  const range = resolveRange({ range: one(p.range), from: one(p.from), to: one(p.to), days: one(p.days) }, undefined, "this_year");
  const grainParam = one(p.grain);
  const grain: Grain = grainParam === "day" || grainParam === "week" || grainParam === "month" ? grainParam : autoGrain(range.from, range.to);
  const colorBy = one(p.colorBy) === "payer" ? "payer" : "category";

  const data = await getExpenseAnalytics({
    from: range.from, to: range.to, grain, colorBy,
    categoryIds: many(p.category), payers: many(p.payer), approval: many(p.approval), payment: many(p.payment),
    search: one(p.search) ?? null, includeBills: one(p.bills) === "1",
  });

  // Clicking a bar opens the Expenses list for that period with the same statuses and search.
  const link = new URLSearchParams();
  if (many(p.approval).length === 1) link.set("approvalStatus", many(p.approval)[0]);
  if (many(p.payment).length === 1) link.set("paymentStatus", many(p.payment)[0]);
  if (one(p.search)) link.set("search", one(p.search)!);
  const linkBase = `/expenses${link.toString() ? `?${link}` : ""}`;

  const top = data.series[0];
  const grainWord = grain === "day" ? "day" : grain === "week" ? "week" : "month";

  return (
    <>
      <PageHeader backTo="/expenses" backLabel="Back to expenses" title="Expense analytics"
        description={data.seesEveryone ? "What the business spent over time, by category or by who paid." : "What you spent over time - your own claims only."} />

      <Card className="mb-6">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Date of expense</span>
            <DateRangeFilter key={`${range.preset}-${range.from}-${range.to}-${range.days}`} range={range} keepOtherParams />
          </div>
          <AnalyticsFilters
            categories={[...data.categoryOptions.map((c) => ({ value: c.id, label: c.name }))]}
            payers={data.payerOptions.map((u) => ({ value: u.id, label: u.name }))}
            canSeeBills={data.canSeeBills} grain={grain} colorBy={colorBy}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={<Coins className="h-4 w-4" />} label="Total spent" value={formatMoneyTotal(data.total, "PKR")} sublabel={range.label} />
        <StatTile icon={<Receipt className="h-4 w-4" />} label="Expenses" value={String(data.count)} />
        <StatTile icon={<CalendarRange className="h-4 w-4" />} label={`Average per ${grainWord}`} value={formatMoneyTotal(data.average, "PKR")} sublabel={`${data.periodsWithSpend} of ${data.buckets.length} with spending`} />
        <StatTile icon={colorBy === "category" ? <Tag className="h-4 w-4" /> : <User className="h-4 w-4" />} label={colorBy === "category" ? "Biggest category" : "Biggest payer"} value={top ? top.label : "—"} sublabel={top ? formatMoneyTotal(top.total, "PKR") : undefined} />
        <StatTile icon={<User className="h-4 w-4" />} label={colorBy === "category" ? "Categories" : "Payers"} value={String(data.series.length)} />
      </div>

      {data.excludedCount > 0 && (
        <div className="mt-4"><Alert tone="info">{data.excludedCount} expense{data.excludedCount === 1 ? " is" : "s are"} in {data.excludedCurrencies.join(", ")} and not included; totals are PKR only.</Alert></div>
      )}

      <Card className="mt-6">
        <CardContent className="p-5">
          {data.count === 0 ? (
            <EmptyState title="No expenses match" description="Try a longer period or clear some filters." />
          ) : (
            <ExpenseChart buckets={data.buckets} series={data.series} linkBase={linkBase} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
