/**
 * "Add to calendar" without connecting anyone's account: a Google Calendar
 * link that opens the event already filled in, and an .ics file for Outlook
 * and Apple Calendar. Nothing is sent to Google by the CRM; the person saves
 * the event in their own calendar. Safe for the browser.
 */

export interface CalendarEvent {
  title: string;
  start: Date;
  minutes: number;
  details?: string;
  location?: string;
}

/** 2026-10-28T09:30:00.000Z → 20261028T093000Z */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const end = (e: CalendarEvent) => new Date(e.start.getTime() + e.minutes * 60_000);

export function googleCalendarUrl(e: CalendarEvent): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${stamp(e.start)}/${stamp(end(e))}` });
  if (e.details) p.set("details", e.details);
  if (e.location) p.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** Escapes text for an .ics field and folds lines at 75 characters, as the format requires. */
function icsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fold(line: string) {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 74) out.push((i ? " " : "") + line.slice(i, i + 74));
  return out.join("\r\n");
}

export function icsFile(e: CalendarEvent, uid: string): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BabulTech CRM//Prospecting//EN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@babultech-crm`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(end(e))}`,
    fold(`SUMMARY:${icsText(e.title)}`),
    ...(e.details ? [fold(`DESCRIPTION:${icsText(e.details)}`)] : []),
    ...(e.location ? [fold(`LOCATION:${icsText(e.location)}`)] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

export function downloadIcs(e: CalendarEvent, uid: string, fileName = "meeting.ics") {
  const url = URL.createObjectURL(new Blob([icsFile(e, uid)], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
