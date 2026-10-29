import Link from "next/link";
import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui";
import { getTeamTimesheets } from "@/server/weekly-timesheets";

/**
 * This week's timesheets at a glance, on the dashboard of CRM Admins and Super
 * Admins: hours logged against the team's commitment, how many weeks are in,
 * and how many wait for them. Renders nothing for anyone else.
 */
export async function TimesheetPulse() {
  const todayPk = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const d = new Date(`${todayPk}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const thisWeek = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() - 7);
  const lastWeek = d.toISOString().slice(0, 10);
  const [now, last] = await Promise.all([getTeamTimesheets(thisWeek), getTeamTimesheets(lastWeek)]);
  if (!now || !last) return null;
  const committed = now.rows.reduce((s, r) => s + r.committed, 0);
  const logged = now.rows.reduce((s, r) => s + r.logged, 0);
  const behind = now.rows.filter((r) => r.logged < r.committed).length;
  const lastIn = last.rows.filter((r) => r.status === "SUBMITTED" || r.status === "APPROVED").length;
  const waiting = [...now.rows, ...last.rows].filter((r) => r.status === "SUBMITTED" && r.canDecide).length;
  return (
    <Card className="mb-4">
      <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 py-4 text-sm">
        <span className="flex items-center gap-2 font-medium"><Clock className="h-4 w-4" /> Timesheets</span>
        <span>This week: <b>{Math.round(logged)}</b> of {Math.round(committed)} h logged, {behind} behind</span>
        <span>Last week: <b>{lastIn}</b> of {last.rows.length} submitted</span>
        <span>Waiting for you: <b>{waiting}</b></span>
        <Link href={`/timesheets/approvals?week=${waiting && !now.rows.some((r) => r.status === "SUBMITTED" && r.canDecide) ? lastWeek : thisWeek}`} className="ml-auto text-primary hover:underline">Team timesheets</Link>
      </CardContent>
    </Card>
  );
}
