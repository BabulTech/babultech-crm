import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getCompanyInformation } from "@/server/company";
import { PageHeader, Forbidden } from "@/components/ui";
import { BusinessHoursForm } from "./hours-form";
import { HolidaysEditor } from "./holidays-editor";

export default async function BusinessHoursPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="business hours" />;

  const { businessHours } = await getCompanyInformation();
  const current = businessHours.find((h) => h.isDefault) ?? businessHours[0] ?? null;

  return (
    <>
      <PageHeader
        backTo="/overview?tab=profile"
        backLabel="Back to Company overview"
        title="Business hours"
        description="Your working week. Support clocks only run inside these hours, so a day marked closed is a day an SLA does not count."
      />
      <BusinessHoursForm current={current} />
      {current && <HolidaysEditor businessHoursId={current.id} holidays={current.holidayCalendar ?? []} />}
    </>
  );
}
