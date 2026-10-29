import Link from "next/link";
import { getMyWeek, getTimeEntryOptions } from "@/server/timesheets";
import { getMyTimesheetWeek } from "@/server/weekly-timesheets";
import { requireUser } from "@/lib/authz";
import { PageHeader, Button } from "@/components/ui";
import { serialize } from "@/lib/utils";
import { TimesheetClient, type Entry, type EntryOptions } from "./timesheet-client";
import { WeekCommitment } from "./week-commitment";

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requireUser();
  const { week } = await searchParams;

  // Monday of the chosen week (default this week, Pakistan time), as plain dates
  // so the server's own time zone cannot shift it a day.
  const todayPk = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const base = new Date(`${week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : todayPk}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - ((base.getUTCDay() + 6) % 7));
  const weekStartISO = base.toISOString().slice(0, 10);

  const [{ entries }, options, sheet] = await Promise.all([
    getMyWeek(weekStartISO),
    getTimeEntryOptions(),
    getMyTimesheetWeek(weekStartISO),
  ]);
  const approves = sheet?.rank === "SUPER" || sheet?.rank === "CRM_ADMIN";

  return (
    <>
      <PageHeader
        title="My timesheet"
        description="Log your time every day, then submit the week (Monday to Sunday) by Sunday night. A short week needs a reason."
      >
        {approves && (
          <Button asChild variant="outline">
            <Link href="/timesheets/approvals">Team timesheets</Link>
          </Button>
        )}
      </PageHeader>

      {sheet?.keepsTimesheet && (
        <div className="mb-6">
          <WeekCommitment weekStart={weekStartISO} week={sheet} isFuture={weekStartISO > todayPk} />
        </div>
      )}

      <TimesheetClient
        weekStart={weekStartISO}
        entries={serialize(entries) as unknown as Entry[]}
        options={serialize(options) as unknown as EntryOptions}
      />
    </>
  );
}
