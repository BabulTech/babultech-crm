import { getSalesTime, getTimeEntryOptions } from "@/server/timesheets";
import { TimeSpentPanel } from "./time-spent-panel";
import type { SalesType } from "@/lib/sales-types";

/** Drop-in for a record page: loads its time and renders the panel. */
export async function TimeSpentSection({ type, id, label }: { type: SalesType; id: string; label: string }) {
  const [rows, options] = await Promise.all([getSalesTime(type, id), getTimeEntryOptions()]);
  return <TimeSpentPanel type={type} id={id} label={label} rows={rows} options={options as never} />;
}
