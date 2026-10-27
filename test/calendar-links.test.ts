import { describe, expect, it } from "vitest";
import { googleCalendarUrl, icsFile } from "@/lib/calendar-links";

const event = {
  title: "Meeting with Smile Dental, Toronto",
  start: new Date("2026-11-03T10:30:00Z"),
  minutes: 45,
  details: "With Jane Smith, Owner\nPhone: +1 416 555 0100",
  location: "12 King St, Toronto",
};

describe("calendar links", () => {
  it("opens Google Calendar with the event filled in, in UTC", () => {
    const url = new URL(googleCalendarUrl(event));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe(event.title);
    expect(url.searchParams.get("dates")).toBe("20261103T103000Z/20261103T111500Z");
    expect(url.searchParams.get("details")).toBe(event.details);
    expect(url.searchParams.get("location")).toBe(event.location);
  });

  it("writes a valid .ics event with escaped text", () => {
    const ics = icsFile(event, "abc");
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("DTSTART:20261103T103000Z");
    expect(ics).toContain("DTEND:20261103T111500Z");
    expect(ics).toContain("SUMMARY:Meeting with Smile Dental\\, Toronto");
    expect(ics).toContain("DESCRIPTION:With Jane Smith\\, Owner\\nPhone: +1 416 555 0100");
    expect(ics.split("\r\n").every((line) => line.length <= 75)).toBe(true);
  });
});
