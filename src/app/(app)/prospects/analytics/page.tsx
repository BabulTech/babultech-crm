import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardContent, CardHeader, CardTitle, StatTile, Select, Button, Forbidden, Table, THead, TBody, TR, TH, TD, Alert } from "@/components/ui";
import { formatDate, formatNumber } from "@/lib/utils";
import { getOutreachAnalytics } from "@/server/prospect-analytics";
import { listProspectCampaigns, listProspectWorkers } from "@/server/prospect-campaigns";

type Params = { days?: string; campaignId?: string; userId?: string };

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "am" : "pm"}`;

/** Today in Pakistan time, as yyyy-mm-dd, and n days before it. */
function range(days: number) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: today };
}

export default async function OutreachAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const q = await searchParams;
  const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
  const { from, to } = range(days);
  const [a, campaigns, people] = await Promise.all([
    getOutreachAnalytics({ from, to, campaignId: q.campaignId, userId: q.userId }),
    listProspectCampaigns(),
    listProspectWorkers(),
  ]);

  const t = a.totals;
  const sends = t.emails + t.followups;
  const calls = t.callsNoAnswer + t.callsConnected + t.voicemails;
  const replyRate = pct(t.replies, sends);
  const connectRate = pct(t.callsConnected, calls);
  const maxHour = Math.max(1, ...a.hours.map((h) => h.n));
  const bestHour = [...a.hours].filter((h) => h.n >= 5).sort((x, y) => y.good / y.n - x.good / x.n)[0];
  const bestDay = [...a.weekdays].filter((w) => w.calls >= 5).sort((x, y) => y.connected / y.calls - x.connected / x.calls)[0];
  const f = a.funnel;
  const funnel = [
    { label: "In campaigns", n: f.inCampaigns },
    { label: "Worked", n: f.worked },
    { label: "Replied", n: f.replied },
    { label: "Interested / meeting", n: f.meetings },
    { label: "Qualified to leads", n: f.qualified },
  ];

  // What the numbers say, in sentences, only when there is enough to go on.
  const notes: { tone: "success" | "warning" | "info"; text: string }[] = [];
  if (calls >= 20) {
    notes.push(connectRate >= 30
      ? { tone: "success", text: `${formatNumber(connectRate, 0)}% of calls connected - a strong reach.` }
      : { tone: "warning", text: `Only ${formatNumber(connectRate, 0)}% of calls connected. Try other hours, or numbers for a named person.` });
    if (t.callsNoAnswer > calls / 2) notes.push({ tone: "warning", text: `${formatNumber(t.callsNoAnswer, 0)} calls went unanswered - more than half.` });
  }
  if (sends >= 20) {
    notes.push(replyRate >= 5
      ? { tone: "success", text: `${formatNumber(replyRate, 1)}% of emails got a reply.` }
      : { tone: "warning", text: `${formatNumber(replyRate, 1)}% of emails got a reply. The message or the list may need work.` });
  }
  if (bestHour) notes.push({ tone: "info", text: `Most answers and replies come around ${hourLabel(bestHour.hour)}.` });
  if (bestDay) notes.push({ tone: "info", text: `${WEEKDAYS[bestDay.dow]} is the best calling day (${formatNumber(pct(bestDay.connected, bestDay.calls), 0)}% connect).` });
  if (f.worked >= 20 && f.replied === 0) notes.push({ tone: "warning", text: "Prospects are being worked but none have replied yet." });

  return (
    <>
      <PageHeader title="Outreach analytics" description={`What the team logged from ${formatDate(from)} to ${formatDate(to)}, and how far prospects got.`} backTo="/prospects" backLabel="Prospects" />

      <Card className="mb-6">
        <form className="flex flex-wrap items-end gap-3 p-4">
          <Select name="days" defaultValue={String(days)} className="w-40" aria-label="Period">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
          <Select name="campaignId" defaultValue={q.campaignId ?? ""} className="w-64" aria-label="Campaign">
            <option value="">All campaigns</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select name="userId" defaultValue={q.userId ?? ""} className="w-56" aria-label="Person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
          <Button type="submit" variant="secondary">Show</Button>
        </form>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Emails sent" value={formatNumber(sends, 0)} sublabel={`${formatNumber(t.followups, 0)} of them follow-ups`} />
        <StatTile label="Replies" value={formatNumber(t.replies, 0)} sublabel={sends ? `${formatNumber(replyRate, 1)}% reply rate` : undefined} tone={t.replies ? "success" : "neutral"} />
        <StatTile label="Calls" value={formatNumber(calls, 0)} sublabel={`${formatNumber(t.callsConnected, 0)} connected · ${formatNumber(t.voicemails, 0)} voicemail`} />
        <StatTile label="Connect rate" value={calls ? `${formatNumber(connectRate, 0)}%` : "—"} tone={calls && connectRate >= 30 ? "success" : calls ? "warning" : "neutral"} />
        <StatTile label="Meetings booked" value={formatNumber(t.meetings, 0)} tone={t.meetings ? "success" : "neutral"} />
        <StatTile label="Prospects touched" value={formatNumber(t.prospectsTouched, 0)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Funnel</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {funnel.map((s, i) => (
              <div key={s.label}>
                <div className="flex justify-between text-sm">
                  <span>{s.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(s.n, 0)}
                    {i > 0 && funnel[i - 1].n > 0 && <span className="ml-2 text-xs">{formatNumber(pct(s.n, funnel[i - 1].n), 0)}% of the step before</span>}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(1, pct(s.n, Math.max(1, funnel[0].n)))}%` }} />
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Campaign stages are as they stand now; qualified counts leads handed to sales in this period.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>What the numbers say</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {notes.length ? notes.map((n) => <Alert key={n.text} tone={n.tone}>{n.text}</Alert>) : (
              <p className="text-sm text-muted-foreground">Not enough logged in this period to say much yet. Notes appear once there are 20 or more calls or emails.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Daily tracker</CardTitle></CardHeader>
        <CardContent className="p-0">
          {a.daily.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Nothing logged in this period.</p> : (
            <Table>
              <THead>
                <TR><TH>Day</TH><TH>Emails</TH><TH>Replies</TH><TH>Reply rate</TH><TH>Calls</TH><TH>Connected</TH><TH>Meetings</TH><TH priority="secondary">Outreach window</TH></TR>
              </THead>
              <TBody>
                {a.daily.map((d) => (
                  <TR key={d.day}>
                    <TD className="whitespace-nowrap">{formatDate(d.day)}</TD>
                    <TD className="tabular-nums">{d.sends}</TD>
                    <TD className="tabular-nums">{d.replies}</TD>
                    <TD className="tabular-nums">{d.sends ? `${formatNumber(pct(d.replies, d.sends), 1)}%` : "—"}</TD>
                    <TD className="tabular-nums">{d.calls}</TD>
                    <TD className="tabular-nums">{d.connected}</TD>
                    <TD className="tabular-nums">{d.meetings}</TD>
                    <TD priority="secondary" className="whitespace-nowrap text-sm text-muted-foreground">{d.firstAt ? (d.firstAt === d.lastAt ? d.firstAt : `${d.firstAt} – ${d.lastAt}`) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Time of day</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {a.hours.length === 0 ? <p className="text-sm text-muted-foreground">Nothing logged yet.</p> : a.hours.map((h) => (
              <div key={h.hour} className="flex items-center gap-2 text-sm">
                <span className="w-14 shrink-0 text-muted-foreground">{hourLabel(h.hour)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${(h.n / maxHour) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right tabular-nums text-xs text-muted-foreground">{h.n} · {h.good} answered</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Day of week</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead><TR><TH>Day</TH><TH>Calls</TH><TH>Connected</TH><TH>Connect rate</TH><TH>Replies</TH></TR></THead>
              <TBody>
                {a.weekdays.map((w) => (
                  <TR key={w.dow}>
                    <TD>{WEEKDAYS[w.dow]}</TD>
                    <TD className="tabular-nums">{w.calls}</TD>
                    <TD className="tabular-nums">{w.connected}</TD>
                    <TD className="tabular-nums">{w.calls ? `${formatNumber(pct(w.connected, w.calls), 0)}%` : "—"}</TD>
                    <TD className="tabular-nums">{w.replies}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>By person</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead><TR><TH>Person</TH><TH>Emails</TH><TH>Calls</TH><TH>Connected</TH><TH>Replies</TH><TH>Meetings</TH></TR></THead>
              <TBody>
                {a.people.map((p) => (
                  <TR key={p.id ?? p.name}>
                    <TD>{p.name}</TD>
                    <TD className="tabular-nums">{p.sends}</TD>
                    <TD className="tabular-nums">{p.calls}</TD>
                    <TD className="tabular-nums">{p.connected}</TD>
                    <TD className="tabular-nums">{p.replies}</TD>
                    <TD className="tabular-nums">{p.meetings}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By campaign</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead><TR><TH>Campaign</TH><TH>Prospects</TH><TH>Worked</TH><TH>Replied</TH><TH>Meeting</TH><TH>Won</TH></TR></THead>
              <TBody>
                {a.campaigns.map((c) => (
                  <TR key={c.id}>
                    <TD><a href={`/prospects/campaigns/${c.id}`} className="hover:underline">{c.name}</a></TD>
                    <TD className="tabular-nums">{formatNumber(c.total, 0)}</TD>
                    <TD className="tabular-nums">{formatNumber(c.worked, 0)}</TD>
                    <TD className="tabular-nums">{formatNumber(c.replied, 0)}</TD>
                    <TD className="tabular-nums">{formatNumber(c.meetings, 0)}</TD>
                    <TD className="tabular-nums">{formatNumber(c.won, 0)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
