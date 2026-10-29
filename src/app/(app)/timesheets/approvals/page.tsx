import { requireUser } from "@/lib/authz";
import { PageHeader, Forbidden, StatTile } from "@/components/ui";
import { getTeamTimesheets } from "@/server/weekly-timesheets";
import { formatDate, formatNumber } from "@/lib/utils";
import { TeamTimesheets } from "./team-timesheets";

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Team timesheets: every employee's committed and logged hours for a week,
 * whether it is submitted, and approving or returning it. CRM Admins and
 * Super Admins only; a CRM Admin's week is approved by a Super Admin.
 */
export default async function TeamTimesheetsPage({ searchParams }: { searchParams: Promise<{ week?: string; show?: string }> }) {
  await requireUser();
  const { week, show } = await searchParams;
  const todayPk = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const base = new Date(`${week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : todayPk}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7));
  const weekStart = base.toISOString().slice(0, 10);

  const data = await getTeamTimesheets(weekStart);
  if (!data) return <Forbidden what="team timesheets" />;
  const { rows } = data;
  const committed = rows.reduce((s, r) => s + r.committed, 0);
  const logged = rows.reduce((s, r) => s + r.logged, 0);
  const submitted = rows.filter((r) => r.status === "SUBMITTED" || r.status === "APPROVED").length;
  const approved = rows.filter((r) => r.status === "APPROVED").length;
  const waiting = rows.filter((r) => r.status === "SUBMITTED" && r.canDecide).length;
  const behind = rows.filter((r) => r.logged < r.committed).length;

  return (
    <>
      <PageHeader
        backTo="/timesheets"
        backLabel="My timesheet"
        title="Team timesheets"
        description={`Week of ${formatDate(weekStart)} to ${formatDate(addDays(weekStart, 6))}. Committed hours come from each person's employment contract, or 40 when they have none.`}
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Hours logged" value={`${formatNumber(logged, 0)} / ${formatNumber(committed, 0)}`} sublabel={committed ? `${Math.round((logged / committed) * 100)}% of commitment` : undefined} />
        <StatTile label="Submitted" value={`${submitted} of ${rows.length}`} />
        <StatTile label="Approved" value={String(approved)} />
        <StatTile label="Waiting for you" value={String(waiting)} />
        <StatTile label="Behind on hours" value={String(behind)} />
      </div>
      <TeamTimesheets weekStart={weekStart} prevWeek={addDays(weekStart, -7)} nextWeek={addDays(weekStart, 7)} isCurrent={weekStart >= addDays(todayPk, -6)} rows={rows} show={show ?? "all"} />
    </>
  );
}
