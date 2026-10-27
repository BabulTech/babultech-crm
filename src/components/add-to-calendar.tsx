"use client";

import { useEffect, useState } from "react";
import { CalendarPlus, Download } from "lucide-react";
import { Button } from "@/components/ui";
import { downloadIcs, googleCalendarUrl, type CalendarEvent } from "@/lib/calendar-links";

/**
 * Two buttons: open the event in Google Calendar, or save it as an .ics file.
 * `crmPath` adds a link back to the CRM, from whatever address the page is
 * open on, once the page has loaded.
 */
export function AddToCalendar({ event, uid, crmPath, size = "sm" }: {
  event: Omit<CalendarEvent, "start"> & { start: string };
  uid: string;
  crmPath?: string;
  size?: "sm" | "default";
}) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const details = [event.details, crmPath && origin ? `In the CRM: ${origin}${crmPath}` : null].filter(Boolean).join("\n") || undefined;
  const e: CalendarEvent = { ...event, start: new Date(event.start), details };
  return (
    <span className="inline-flex flex-wrap gap-2">
      <Button asChild size={size} variant="outline">
        <a href={googleCalendarUrl(e)} target="_blank" rel="noopener noreferrer">
          <CalendarPlus className="h-4 w-4" /> Add to Google Calendar
        </a>
      </Button>
      <Button type="button" size={size} variant="ghost" onClick={() => downloadIcs(e, uid, `${event.title.replace(/[^\w\- ]+/g, "").trim() || "meeting"}.ics`)}>
        <Download className="h-4 w-4" /> .ics
      </Button>
    </span>
  );
}
