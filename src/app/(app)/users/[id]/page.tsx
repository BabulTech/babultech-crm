import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck, Handshake } from "lucide-react";
import { getUser, getUserWorkload } from "@/server/users";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getAuditTrail } from "@/lib/audit";
import { auditFieldLabel } from "@/lib/audit-format";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, Button, DetailRow, Alert, Forbidden,
} from "@/components/ui";
import { formatMoney, formatDate, formatDateTime, humanize } from "@/lib/utils";
import { PasswordPanel } from "./password-panel";
import { ViewAsButton } from "./view-as-button";
import { viewAsRefusal } from "@/server/view-as";
import { listLoginEvents } from "@/server/security";
import { getLatestPasswordLink } from "@/server/password-links";
import { LoginHistory } from "@/components/login-history";
import { RecordTabs } from "@/components/record-tabs";
import {
  TimePanel, DailyTrend, TaskPanel, UpcomingTasks, WhereHoursWent,
  CasePanel, ContributionPanel, WorkloadTiles,
} from "./workload-panels";

const SCOPE_EXPLAINER: Record<string, string> = {
  OWN: "Only records they own",
  TEAM: "Their team's records",
  DEPARTMENT: "Their own records and reporting subtree",
  ALL: "Every record in the system",
};

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="user administration" />;

  const { id } = await params;
  const user = await getUser(id);
  if (!user) notFound();

  const isAdmin = user.role?.permissions?.includes("*") ?? false;
  const isPartner = Boolean(user.partnerId);
  const missingRates = !isPartner && (!user.costRate || !user.defaultBillingRate);

  // One wave: neither call needs the other's result, and the page cannot render
  // until both are in.
  //
  // A partner login is an external account with no timesheet, no tasks and no
  // cases of its own, so the delivery half does not merely come back empty for
  // them — it does not apply. Skipping it keeps the page honest and saves three
  // selects.
  const [audit, workload, signIns, latestLink] = await Promise.all([
    getAuditTrail("User", id, 15),
    isPartner ? Promise.resolve(null) : getUserWorkload(id),
    listLoginEvents({ userId: id, limit: 15 }),
    getLatestPasswordLink(id),
  ]);
  const canViewAs = can(me, "user:view_as");
  const viewAsBlocked = canViewAs
    ? await viewAsRefusal(
        { id: user.id, status: user.status, deletedAt: user.deletedAt ?? null, permissions: user.role?.permissions ?? [] },
        me.id,
      )
    : null;

  return (
    <>
      <PageHeader
        backTo="/users"
        backLabel="Back to users"
        title={user.fullName}
        description={`${user.email}${user.jobTitle ? ` · ${user.jobTitle}` : ""}`}
      >
        <Badge tone={user.userType === "INTERNAL" ? "neutral" : user.userType === "PARTNER" ? "warning" : "info"}>
          {user.userType === "INTERNAL" ? "Employee" : user.userType === "PARTNER" ? "Partner login" : "Customer login"}
        </Badge>
        <Badge tone={isAdmin ? "danger" : isPartner ? "warning" : "neutral"}>{(user.role?.name ?? "—")}</Badge>
        <Badge tone={statusTone(user.status)}>{humanize(user.status)}</Badge>
        {canViewAs && <ViewAsButton userId={user.id} name={user.fullName} refusal={viewAsBlocked} />}
        <Button asChild variant="outline"><Link href={`/users/${user.id}/teams`}>Manage teams</Link></Button>
        <Button asChild variant="outline">
          <Link href={`/users/${user.id}/edit`}>Edit</Link>
        </Button>
      </PageHeader>

      {isPartner && (
        <div className="mb-5">
          <Alert tone="warning">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Handshake className="h-4 w-4" /> External partner login
            </span>
            <p className="mt-0.5">
              Everything this account can see is scoped through{" "}
              <Link href={`/partners/${user.partner!.id}`} className="underline">
                {user.partner!.displayName}
              </Link>. It is not an employee record and carries no rates.
            </p>
          </Alert>
        </div>
      )}
      {isAdmin && (
        <div className="mb-5">
          <Alert tone="danger">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ShieldCheck className="h-4 w-4" /> Full administrator
            </span>
            <p className="mt-0.5">Every permission, every record. Grant this sparingly.</p>
          </Alert>
        </div>
      )}
      {missingRates && (
        <div className="mb-5">
          <Alert tone="warning">
            No {!user.costRate ? "cost rate" : ""}{!user.costRate && !user.defaultBillingRate ? " or " : ""}
            {!user.defaultBillingRate ? "billing rate" : ""} set. Their logged time will cost nothing
            and their utilisation will read zero.
          </Alert>
        </div>
      )}

      {/* Delivery first, access second. Someone opening a colleague's record
          usually wants to know what they are working on; the role and scope are
          what you check when you are changing permissions, which is rarer. */}
      {workload && (
        <WorkloadTiles
          time={workload.time}
          utilisation={workload.utilisation}
          tasks={workload.tasks}
          cases={workload.cases}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Data scope" value={humanize((user.role?.dataScope ?? ""))} sublabel={SCOPE_EXPLAINER[(user.role?.dataScope ?? "")]} />
        <StatTile
          label="Permissions"
          value={isAdmin ? "All" : String((user.role?.permissions ?? []).length)}
          sublabel={(user.role?.name ?? "—")}
          tone={isAdmin ? "danger" : "neutral"}
        />
        <StatTile
          label="On projects"
          value={String(user.projectMemberships.length)}
          sublabel={`${user.reports.length} direct report(s)`}
        />
        <StatTile
          label="Last signed in"
          value={user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}
          sublabel={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Account unused"}
          tone={user.lastLoginAt ? "neutral" : "warning"}
        />
      </div>

      {/* The delivery record sits in tabs rather than another six stacked
          panels: time, tasks and tickets are each a full screen of detail, and
          a reader wants one of them at a time. The access half below stays
          outside, because changing a role is a different job from reviewing
          someone's work and should not be a tab click away from it. */}
      {workload && (
        <div className="mt-6">
          <RecordTabs
            param="work"
            tabs={[
              {
                value: "time",
                label: "Time",
                content: (
                  <div className="space-y-6">
                    <TimePanel time={workload.time} utilisation={workload.utilisation} />
                    <DailyTrend daily={workload.daily} />
                    <WhereHoursWent byTask={workload.byTask} byProject={workload.byProject} />
                  </div>
                ),
              },
              {
                value: "tasks",
                label: "Tasks",
                count: workload.tasks.open,
                content: (
                  <div className="space-y-6">
                    <TaskPanel tasks={workload.tasks} estimates={workload.estimates} />
                    <UpcomingTasks tasks={workload.tasks} />
                  </div>
                ),
              },
              {
                value: "tickets",
                label: "Tickets",
                count: workload.cases.open,
                content: <CasePanel cases={workload.cases} />,
              },
              {
                value: "contribution",
                label: "Contribution",
                content: (
                  <div className="grid gap-6 sm:grid-cols-2">
                    <ContributionPanel money={workload.money} quality={workload.quality} />
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>What this role allows</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {user.role?.description && (
                <p className="text-sm text-muted-foreground">{user.role?.description}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {(user.role?.permissions ?? []).map((p: string) => (
                  <Badge key={p} tone={p === "*" ? "danger" : "neutral"} className="font-mono">
                    {p === "*" ? "everything" : p}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Permissions are the ceiling; the data scope narrows which rows they apply to. Both
                are checked server-side on every page and action.
              </p>
            </CardContent>
          </Card>

          {user.projectMemberships.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Booked on</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {user.projectMemberships.map((m: Record<string, any>) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
                    <div className="min-w-0">
                      <Link href={`/projects/${m.project?.id}`} className="font-medium hover:underline">
                        {m.project?.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {m.projectRole} · {Number(m.allocationPercent ?? 0)}% allocated
                      </p>
                    </div>
                    <Badge tone={statusTone(m.project?.status)}>{humanize(m.project?.status)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {user.reports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Direct reports</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {user.reports.map((r: Record<string, any>) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
                    <Link href={`/users/${r.id}`} className="hover:underline">
                      {r.fullName}
                      <span className="block text-xs text-muted-foreground">{r.jobTitle ?? "—"}</span>
                    </Link>
                    <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <LoginHistory events={signIns} />

          <Card>
            <CardHeader>
              <CardTitle>Change history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {audit.length === 0 ? (
                <p className="text-muted-foreground">No changes recorded.</p>
              ) : (
                audit.map((a: Record<string, any>) => (
                  <div key={a.id}>
                    <p>
                      <span className="font-medium">{auditFieldLabel(a.fieldName)}</span>{" "}
                      <span className="text-muted-foreground">
                        {a.fieldName === "passwordHash"
                          ? "was reset"
                          : `${a.oldValue ?? "empty"} → ${a.newValue ?? "empty"}`}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.changedBy?.fullName ?? "System"} · {formatDate(a.changedAt)}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <PasswordPanel userId={user.id} fullName={user.fullName} email={user.email} latestLink={latestLink} />

          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Email">{user.email}</DetailRow>
              <DetailRow label="Phone">{user.phone ?? "—"}</DetailRow>
              <DetailRow label="Job title">{user.jobTitle ?? "—"}</DetailRow>
              {!isPartner && (
                <>
                  <DetailRow label="Employee number">{user.employeeNumber ?? "—"}</DetailRow>
                  <DetailRow label="Department">{user.department?.name ?? "—"}</DetailRow>
                  <DetailRow label="Reports to">
                    {user.manager ? (
                      <Link href={`/users/${user.manager?.id}`} className="text-primary hover:underline">
                        {user.manager?.fullName}
                      </Link>
                    ) : "—"}
                  </DetailRow>
                  <DetailRow label="Cost rate">{formatMoney(user.costRate)}</DetailRow>
                  <DetailRow label="Billing rate">{formatMoney(user.defaultBillingRate)}</DetailRow>
                </>
              )}
              {isPartner && (
                <DetailRow label="Partner">
                  <Link href={`/partners/${user.partner!.id}`} className="text-primary hover:underline">
                    {user.partner!.displayName}
                  </Link>
                  <p className="text-xs text-muted-foreground">{user.partner!.partnerNumber}</p>
                </DetailRow>
              )}
              <DetailRow label="Teams">
                {user.teamMemberships.length === 0
                  ? "—"
                  : user.teamMemberships.map((t: Record<string, any>) => t.team?.name).join(", ")}
              </DetailRow>
              <DetailRow label="Created">{formatDate(user.createdAt)}</DetailRow>
            </CardContent>
          </Card>
          <RecordEmail entityType="User" entityId={user.id} />
        </div>
      </div>
    </>
  );
}
