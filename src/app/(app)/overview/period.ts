export const RANGES = [
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-90", label: "Last 90 days" },
] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The chosen period as dates, in Pakistan time. */
export function period(key: string): { from: string; to: string } {
  const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())}T00:00:00Z`);
  const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
  const monday = add(today, -((today.getUTCDay() + 6) % 7));
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  switch (key) {
    case "this-week": return { from: iso(monday), to: iso(today) };
    case "last-week": return { from: iso(add(monday, -7)), to: iso(add(monday, -1)) };
    case "last-month": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case "this-quarter": return { from: iso(new Date(Date.UTC(y, m - (m % 3), 1))), to: iso(today) };
    case "last-90": return { from: iso(add(today, -89)), to: iso(today) };
    default: return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) };
  }
}

