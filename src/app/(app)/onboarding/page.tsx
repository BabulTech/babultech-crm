import Link from "next/link";
import { BookCheck } from "lucide-react";
import { listOnboardings } from "@/server/onboarding";
import { listOfferings } from "@/server/offerings";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { ListFilters } from "@/components/list-filters";
import { PageHeader, Card, EmptyState, Badge, Button, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export default async function OnboardingListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; offeringId?: string; search?: string; overdue?: string }>;
}) {
  const me = await requireUser();
  const params = await searchParams;
  const [rows, offerings] = await Promise.all([
    listOnboardings({ status: params.status, offeringId: params.offeringId, search: params.search, overdue: params.overdue === "1" }),
    listOfferings(true),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title="Onboarding" description="Every won customer being set up, from kickoff to live. Started automatically when a deal is marked Closed won.">
        {can(me, PERMISSIONS.SALES_SETUP) && (
          <Button asChild variant="outline"><Link href="/onboarding/playbooks"><BookCheck className="h-4 w-4" /> Playbooks</Link></Button>
        )}
      </PageHeader>

      <ListFilters
        searchPlaceholder="Search customer or number…"
        searchValue={params.search}
        selects={[
          { name: "status", allLabel: "In progress", value: params.status, options: [{ value: "LIVE", label: "Live" }, { value: "CANCELLED", label: "Cancelled" }] },
          { name: "offeringId", allLabel: "Any offering", value: params.offeringId, options: offerings.map((o) => ({ value: o.id, label: o.name })) },
          { name: "overdue", allLabel: "Overdue or not", value: params.overdue, options: [{ value: "1", label: "Has overdue steps" }] },
        ]}
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="Nobody here" description="When a deal is marked Closed won, its customer's onboarding appears here with the steps from the offering's playbook." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Customer</TH><TH>Offering</TH><TH>Progress</TH><TH>Next step</TH><TH>Target live</TH><TH>Manager</TH></TR></THead>
              <TBody>
                {rows.map((o) => {
                  const pct = o.summary.total ? Math.round((o.summary.done / o.summary.total) * 100) : 0;
                  return (
                    <TR key={o.id} data-onboarding={o.onboardingNumber}>
                      <TD>
                        <Link href={`/onboarding/${o.id}`} className="font-medium hover:underline">{o.account?.name ?? o.name}</Link>
                        <div className="text-xs text-muted-foreground">{o.onboardingNumber}</div>
                      </TD>
                      <TD className="text-sm">{o.offering?.name ?? "—"}</TD>
                      <TD className="min-w-[140px]">
                        <div className="h-2 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} /></div>
                        <div className="mt-1 text-xs text-muted-foreground">{o.summary.done} of {o.summary.total} done</div>
                      </TD>
                      <TD className="text-sm">
                        {o.status === "LIVE" ? <Badge tone="success">Live</Badge> : o.status === "CANCELLED" ? <Badge>Cancelled</Badge> : o.summary.next ? (
                          <>
                            {o.summary.next.title}
                            <div className="flex flex-wrap gap-1 text-xs">
                              {o.summary.next.dueDate && <span className={o.summary.next.dueDate < today ? "text-red-600" : "text-muted-foreground"}>due {formatDate(o.summary.next.dueDate)}</span>}
                              {o.summary.waitingOnCustomer && <Badge tone="warning">Waiting on customer</Badge>}
                              {o.summary.overdue > 0 && <Badge tone="danger">{o.summary.overdue} overdue</Badge>}
                              {o.summary.onHold > 0 && <Badge tone="danger">{o.summary.onHold} on hold</Badge>}
                            </div>
                          </>
                        ) : "All steps done"}
                      </TD>
                      <TD className="text-sm">{formatDate(o.targetGoLive)}</TD>
                      <TD className="text-sm">{o.manager?.fullName ?? "—"}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
