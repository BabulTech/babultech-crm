import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, Button, Forbidden } from "@/components/ui";
import { formatNumber } from "@/lib/utils";
import { countProspectTasks, listProspectTasks } from "@/server/prospect-campaigns";
import { TaskList } from "./task-list";

type Params = { tab?: string; who?: string; page?: string };

const TABS = [
  { key: "today", label: "Due today" },
  { key: "overdue", label: "Overdue" },
  { key: "upcoming", label: "Upcoming" },
  { key: "done", label: "Done" },
] as const;

export default async function ProspectTasksPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const q = await searchParams;
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab! : "today";
  const mine = q.who !== "all";
  const page = Math.max(0, Number(q.page ?? 0) || 0);
  const [tasks, counts] = await Promise.all([listProspectTasks({ tab, mine }, page), countProspectTasks({ mine })]);

  // Plain links: a client-side change of only the query string did not take
  // effect on the production build.
  const link = (changes: Record<string, string | null>) => {
    const p = new URLSearchParams(Object.entries({ tab, who: mine ? null : "all", ...changes }).filter(([, v]) => v) as [string, string][]);
    return `/prospects/tasks?${p.toString()}`;
  };
  const count = (key: string) => (key === "today" ? counts.today : key === "overdue" ? counts.overdue : key === "upcoming" ? counts.upcoming : null);

  return (
    <>
      <PageHeader title="Outreach tasks" description="Follow-ups and call-backs from prospect outreach. Quick log creates most of them for you." backTo="/prospects" backLabel="Prospects">
        <Button asChild variant={mine ? "default" : "outline"}><a href={link({ who: null, page: null })}>Mine</a></Button>
        <Button asChild variant={mine ? "outline" : "default"}><a href={link({ who: "all", page: null })}>Everyone&apos;s</a></Button>
      </PageHeader>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button key={t.key} asChild variant={tab === t.key ? "default" : "outline"} size="sm">
            <a href={link({ tab: t.key, page: null })}>
              {t.label}{count(t.key) != null ? ` (${formatNumber(count(t.key)!, 0)})` : ""}
            </a>
          </Button>
        ))}
      </div>
      <Card>
        <TaskList rows={tasks.rows} canWrite={can(me, PERMISSIONS.PROSPECT_WRITE)} showAssignee={!mine} />
        <div className="flex items-center justify-between border-t p-4 text-sm text-muted-foreground">
          <span>{tasks.total ? `${formatNumber(page * 50 + 1, 0)}–${formatNumber(Math.min(tasks.total, (page + 1) * 50), 0)} of ${formatNumber(tasks.total, 0)}` : "Nothing here."}</span>
          <span className="flex gap-2">
            {page > 0 && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page - 1) })}>Previous</a></Button>}
            {(page + 1) * 50 < tasks.total && <Button asChild variant="outline" size="sm"><a href={link({ page: String(page + 1) })}>Next</a></Button>}
          </span>
        </div>
      </Card>
    </>
  );
}
