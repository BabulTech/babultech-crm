import Link from "next/link";
import { notFound } from "next/navigation";
import { getOnboarding } from "@/server/onboarding";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, StatTile } from "@/components/ui";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { OnboardingSettings, CustomerChecklistEmail } from "./step-actions";
import { Checklist } from "./checklist";

export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [o, { data: users }] = await Promise.all([
    getOnboarding(id),
    supabaseAdmin().from("app_user").select("id, fullName").eq("status", "ACTIVE").is("deletedAt", null).is("partnerId", null).or("userType.is.null,userType.eq.INTERNAL").order("fullName"),
  ]);
  if (!o) notFound();
  const today = new Date().toISOString().slice(0, 10);
  const pct = o.summary.total ? Math.round((o.summary.done / o.summary.total) * 100) : 0;
  const customerOpen = o.steps.filter((s) => s.stepType === "CUSTOMER" && s.status === "TODO").length;

  return (
    <>
      <PageHeader backTo="/onboarding" backLabel="Back to onboarding" title={o.account?.name ?? o.name} description={`${o.onboardingNumber} · ${o.playbook?.name ?? "Onboarding"}`}>
        <Badge tone={o.status === "LIVE" ? "success" : o.status === "CANCELLED" ? "neutral" : o.summary.overdue ? "danger" : o.summary.waitingOnCustomer ? "warning" : "info"}>
          {o.status === "LIVE" ? "Live" : o.status === "CANCELLED" ? "Cancelled" : o.summary.waitingOnCustomer ? "Waiting on customer" : "In progress"}
        </Badge>
      </PageHeader>

      {o.status === "CANCELLED" && o.cancelReason && <p className="mb-4 text-sm text-muted-foreground">Cancelled: {o.cancelReason}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Progress" value={`${pct}%`} sublabel={`${o.summary.done} of ${o.summary.total} steps`} />
        <StatTile label="Overdue" value={String(o.summary.overdue)} tone={o.summary.overdue ? "danger" : "success"} />
        <StatTile label={o.status === "LIVE" ? "Went live" : "Target go-live"} value={o.status === "LIVE" ? formatDate(o.wentLiveAt) : formatDate(o.targetGoLive)} sublabel={`Started ${formatDate(o.startDate)}`} />
        <StatTile label="Manager" value={o.manager?.fullName ?? "Nobody"} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Checklist id={o.id} initial={o.steps} status={o.status} me={o.me} canRun={o.canRun} users={users ?? []} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Customer</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {o.account && <p>Account: <Link className="text-primary hover:underline" href={`/accounts/${o.account.id}`}>{o.account.name}</Link></p>}
              {o.opportunity && <p>Deal: <Link className="text-primary hover:underline" href={`/opportunities/${o.opportunity.id}`}>{o.opportunity.opportunityNumber} · {o.opportunity.name}</Link></p>}
              <p>Offering: {o.offering?.name ?? "—"}</p>
              {o.projects.length > 0 && <p>Project: {o.projects.map((p) => <Link key={p.id} className="text-primary hover:underline" href={`/projects/${p.id}`}>{p.projectNumber} · {p.name}</Link>)}</p>}
            </CardContent>
          </Card>
          {o.canRun && o.status === "ACTIVE" && (
            <Card>
              <CardHeader><CardTitle>Ask the customer</CardTitle></CardHeader>
              <CardContent>
                <CustomerChecklistEmail id={o.id} count={customerOpen} contacts={o.contacts.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, email: c.email }))} />
              </CardContent>
            </Card>
          )}
          {o.canRun && (
            <Card>
              <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
              <CardContent><OnboardingSettings id={o.id} managerUserId={o.managerUserId} targetGoLive={o.targetGoLive} status={o.status} users={users ?? []} /></CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {o.history.map((h) => (
                  <li key={h.id} className="border-l-2 pl-3">
                    {h.fieldName === "step" ? `${h.oldValue}: ${h.newValue}` : h.fieldName === "started" ? `Started from ${h.newValue}` : `${humanize(h.fieldName)}: ${h.newValue ?? "—"}`}
                    <div className="text-xs text-muted-foreground">{formatDateTime(h.changedAt)} · {h.changedBy?.fullName ?? "System"}</div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
