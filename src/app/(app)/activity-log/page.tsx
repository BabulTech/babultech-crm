import Link from "next/link";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getEmailHealth, listActivity } from "@/server/activity-log";
import { EmailHealthBanner } from "@/components/email-health-banner";
import { PageHeader } from "@/components/ui";
import { cn, entityHref } from "@/lib/utils";

const CATEGORIES: Record<string, string> = {
  EMAIL: "Email",
  RECORD: "Created / deleted",
  CHANGE: "Changes",
  SIGN_IN: "Sign-ins",
  TIMESHEET: "Timesheets",
  REMINDER: "Reminders",
  SYSTEM: "System",
};
const OUTCOMES: Record<string, string> = { OK: "Done", FAILED: "Failed", SKIPPED: "Skipped" };
const PAGE_SIZE = 100;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const boxClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; outcome?: string; actor?: string; from?: string; to?: string; page?: string }>;
}) {
  const me = await requireUser();
  const { page: pageParam, ...filters } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const [{ rows, total }, health] = await Promise.all([listActivity(filters, page, PAGE_SIZE), getEmailHealth()]);
  const admin = can(me, PERMISSIONS.ADMIN);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
  const pageHref = (n: number) => {
    const next = new URLSearchParams(query);
    next.set("page", String(n));
    return `/activity-log?${next}`;
  };

  return (
    <>
      <PageHeader
        title="Activity log"
        description={admin
          ? "The permanent record of what happened in the portal: emails, records, changes, sign-ins, timesheets and system work. Entries cannot be edited or deleted."
          : "Your own actions in the portal. Entries cannot be edited or deleted."}
      />
      <EmailHealthBanner health={health} />

      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm" method="get">
        <input aria-label="Search" name="q" defaultValue={filters.q} placeholder="Search…" className={boxClass} />
        {admin && <input aria-label="Person" name="actor" defaultValue={filters.actor} placeholder="Person" className={boxClass} />}
        <select aria-label="Type" name="category" defaultValue={filters.category ?? ""} className={boxClass}>
          <option value="">All types</option>
          {Object.entries(CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select aria-label="Result" name="outcome" defaultValue={filters.outcome ?? ""} className={boxClass}>
          <option value="">Any result</option>
          {Object.entries(OUTCOMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input aria-label="From" type="date" name="from" defaultValue={filters.from} className={boxClass} />
        <input aria-label="To" type="date" name="to" defaultValue={filters.to} className={boxClass} />
        <button className="h-9 rounded-md bg-primary px-3 text-primary-foreground">Filter</button>
        <Link href="/activity-log" className="h-9 rounded-md px-3 leading-9 text-muted-foreground hover:bg-accent">Clear</Link>
        <a href={`/activity-log/export?${query}`} className="ml-auto h-9 rounded-md border px-3 leading-9 hover:bg-accent">Export CSV</a>
      </form>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">When (PKT)</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">What happened</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const href = entityHref(r.entityType, r.entityId);
              const error = r.detail?.error as string | undefined;
              return (
                <tr key={r.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{when(r.occurredAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{CATEGORIES[r.category] ?? r.category}</td>
                  <td className="whitespace-nowrap px-3 py-2">{r.actorName ?? "System"}</td>
                  <td className="px-3 py-2">
                    {href ? <Link href={href} className="hover:underline">{r.summary}</Link> : r.summary}
                    {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
                  </td>
                  <td className={cn("whitespace-nowrap px-3 py-2", r.outcome === "FAILED" && "font-medium text-destructive")}>{OUTCOMES[r.outcome] ?? r.outcome}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">Nothing matches these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>{total.toLocaleString()} entries</span>
        <span className="flex gap-3">
          {page > 1 && <Link href={pageHref(page - 1)} className="hover:underline">Newer</Link>}
          {page * PAGE_SIZE < total && <Link href={pageHref(page + 1)} className="hover:underline">Older</Link>}
        </span>
      </div>
    </>
  );
}
