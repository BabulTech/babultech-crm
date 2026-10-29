import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { DeliverablesPanel } from "@/components/deliverables-panel";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { FollowControl } from "@/components/follow-control";
import { SyncFromDeal } from "./sync-from-deal";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { DocumentsPanel } from "@/components/documents-panel";
import { getProject, getProjectBurn, getProjectWorkLog } from "@/server/projects";
import { getProjectPeople } from "@/server/project-directory";
import { getAuditTrail } from "@/lib/audit";
import { countProjectSecrets } from "@/server/secrets";
import { auditFieldLabel } from "@/lib/audit-format";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, Button, Alert, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, formatPercent, formatNumber, humanize, serialize, formatMoneyTotal } from "@/lib/utils";
import { TaskBoard, TeamPanel, PlanPanel, RaidPanel } from "./project-panels";

import { ChangeRequestsPanel } from "./change-requests-panel";
import { RecordTabs } from "@/components/record-tabs";
import { WorkLogPanel } from "./work-log";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { ProjectManagementProvider } from "./management-context";
import { DeleteProjectButton } from "./delete-project-button";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.PROJECT_READ)) return <Forbidden what="projects" />;
  const canManage = can(_me, PERMISSIONS.PROJECT_MANAGE);
  const canViewRates = can(_me, PERMISSIONS.PROJECT_RATES_READ);

  const { id } = await params;

  // One wave, not three.
  //
  // These ran as Promise.all -> await getProject -> Promise.all, so the page
  // paid three round trips end to end before rendering. Against the Mumbai
  // database a single query has a median latency of ~400ms, and none of these
  // seven calls needs a result from any other — every one of them takes only
  // `id`, which is known here. Serialising them was costing roughly two thirds
  // of the wait for nothing.
  //
  // The notFound() check still happens before anything reads `project`; it just
  // no longer holds up the other six queries while it waits.
  const [notes, documents, workLog, project, burn, options, audit, vaultCount] =
    await Promise.all([
      listNotes("Project", id),
      listDocuments("Project", id),
      getProjectWorkLog(id),
      getProject(id),
      getProjectBurn(id),
      // Only the user list is read below, but getProjectFormOptions also fetches
      // accounts, opportunities, contracts and currencies for the edit form —
      // four reference tables pulled on every view of a page that never shows
      // them. At ~400ms a query that is most of a second spent on nothing.
      getProjectPeople().then((users) => ({ users })),
      getAuditTrail("Project", id, 10),
      // Null for anyone without vault access, who sees no link at all.
      countProjectSecrets(id),
    ]);

  if (!project) notFound();

  const approvedHours = Number(project.approvedHours ?? 0);
  const loggedHours = Number(burn.loggedHours);
  const budgetUsed = approvedHours > 0 ? (loggedHours / approvedHours) * 100 : 0;
  const overBudget = approvedHours > 0 && loggedHours > approvedHours;

  const openTasks = project.tasks.filter((t: Record<string, any>) => !["COMPLETED", "CANCELLED"].includes(t.status));
  const overdueTasks = openTasks.filter((t: Record<string, any>) => t.dueDate && t.dueDate < new Date());
  const openRisks = project.risks.filter((r: Record<string, any>) => r.status === "OPEN");
  const openIssues = project.issues.filter((i: Record<string, any>) => i.status === "OPEN");
  const margin = Number(burn.billableValue) - Number(burn.cost);

  const s = serialize({
    tasks: project.tasks,
    phases: project.phases,
    milestones: project.milestones,
    members: project.members,
    risks: project.risks,
    issues: project.issues,
    users: options.users,
  });

  // Sold versus used, across the tasks that came from the deal. Going over is
  // shown rather than refused: the work happened and has to be recorded.
  const soldTasks = (project.tasks as Record<string, any>[]).filter((t) => t.soldHours != null && t.status !== "CANCELLED");
  const soldHours = soldTasks.reduce((sum, t) => sum + Number(t.soldHours), 0);
  const usedHours = soldTasks.reduce((sum, t) => sum + Number(t.loggedHours ?? 0), 0);

  return (
    <>
      <PageHeader
        backTo="/projects"
        backLabel="Back to projects"
        title={project.name}
        description={`${project.projectNumber} · ${project.account?.name ?? "Internal project"}`}
      >
        <Badge tone={statusTone(project.health)}>{humanize(project.health)}</Badge>
        <Badge tone={statusTone(project.status)}>{humanize(project.status)}</Badge>
        {canManage && <Button asChild variant="outline">
          <Link href={`/projects/${project.id}/edit`}>Edit</Link>
        </Button>}
        {canManage && <DeleteProjectButton projectId={project.id} name={`${project.projectNumber} ${project.name}`} />}
        <Button asChild variant="outline"><Link href={`/projects/${id}/content`}>Content calendar</Link></Button>
        {vaultCount !== null && (
          <Button asChild variant="outline"><Link href={`/vault?project=${id}`}>Vault ({vaultCount})</Link></Button>
        )}
        <FollowControl entityType="Project" entityId={id} />
        <CorrectControl type="Project" id={id} />
        <FavoriteControl entityType="Project" entityId={id} label={String(project.name ?? "")} />

        <RecentMark entityType="Project" entityId={id} label={String(project.name ?? "")} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Progress"
          value={formatPercent(project.completionPercent, 0)}
          sublabel={`${project.tasks.length - openTasks.length} of ${project.tasks.length} tasks done`}
          tone="info"
        />
        <StatTile
          label="Hours logged"
          value={formatNumber(burn.loggedHours, 1)}
          sublabel={approvedHours > 0 ? `${formatPercent(budgetUsed, 0)} of ${formatNumber(approvedHours, 0)}h approved` : "No budget set"}
          tone={overBudget ? "danger" : budgetUsed > 80 ? "warning" : "neutral"}
        />
        {canViewRates && <><StatTile
          label="Billable value"
          value={formatMoneyTotal(burn.billableValue, project.currencyCode)}
          sublabel={`Cost ${formatMoney(burn.cost, project.currencyCode)}`}
        />
        <StatTile
          label="Margin to date"
          value={formatMoneyTotal(margin, project.currencyCode)}
          sublabel="Approved time only"
          tone={margin >= 0 ? "success" : "danger"}
        /></>}
      </div>

      {/* What was sold against what has been used, for the tasks that came from
          the deal. Replaces the old cost totals, which flowed the other way -
          from task estimates back into the deal's price. */}
      {soldTasks.length > 0 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Hours sold"
            value={formatNumber(soldHours, 1)}
            sublabel={`${soldTasks.length} task(s) from the deal`}
          />
          <StatTile
            label="Hours used"
            value={formatNumber(usedHours, 1)}
            sublabel={soldHours > 0 ? `${formatPercent((usedHours / soldHours) * 100, 0)} of what was sold` : undefined}
            tone={usedHours > soldHours ? "danger" : usedHours > soldHours * 0.8 ? "warning" : "neutral"}
          />
          <StatTile
            label="Hours remaining"
            value={formatNumber(Math.max(soldHours - usedHours, 0), 1)}
            sublabel={usedHours > soldHours ? `${formatNumber(usedHours - soldHours, 1)}h over what was sold` : "Of the hours sold"}
            tone={usedHours > soldHours ? "danger" : "success"}
          />
          {project.opportunity && (
            <StatTile
              label="Deal"
              value={project.opportunity.opportunityNumber}
              sublabel="Where these hours were sold"
              href={`/opportunities/${project.opportunity.id}`}
            />
          )}
        </div>
      )}

      {project.opportunity && canManage && (
        <div className="mt-4">
          <SyncFromDeal projectId={project.id} />
        </div>
      )}

      {(overBudget || overdueTasks.length > 0) && (
        <div className="mt-5 space-y-3">
          {overBudget && (
            <Alert tone="danger">
              {formatNumber(loggedHours - approvedHours, 1)} hours over the approved budget. Raise a
              change request before logging more time against this engagement.
            </Alert>
          )}
          {overdueTasks.length > 0 && (
            <Alert tone="warning">
              {overdueTasks.length} task(s) are past their due date.
            </Alert>
          )}
        </div>
      )}

      {/* Everything below the headline moved into tabs.

          The page rendered nine panels in one column - a drag board, a second
          task list showing the same tasks, a plan, a team, a RAID log, change
          requests, details, notes and documents. Reaching the team meant
          scrolling past every task card on the project, and nothing on screen
          said which parts mattered.

          What stays above the tabs is what answers "is this project in
          trouble?" - the status, the four figures, and the two alerts. Those
          are read at a glance and acted on; the rest is read on purpose. */}
      {!canManage && <p className="my-4 text-sm text-muted-foreground">Open your assigned task or My Work to update progress. Project setup and assignments are managed by your project manager.</p>}
      <ProjectManagementProvider allowed={canManage} ratesAllowed={canViewRates}>
      <RecordTabs
        tabs={[
          {
            value: "tasks",
            label: "Tasks",
            count: s.tasks.length,
            content: (
              // One board, one source of truth.
              //
              // Two boards of the same tasks were stacked here: TaskBoardView
              // for dragging, TaskBoard for adding and editing. No tool that
              // does this well - ClickUp, Linear, Jira - shows the same tasks
              // twice; a view switcher changes how you see them, never how many
              // copies there are. TaskBoard now drags too, so the second board
              // has nothing left to offer.
              <TaskBoard
                projectId={project.id}
                projectType={project.projectType}
                tasks={s.tasks as never}
                phases={s.phases as never}
                milestones={s.milestones as never}
                members={s.members as never}
              />
            ),
          },
          {
            value: "activity",
            label: "Work log",
            count: workLog.entries.length,
            content: (
              <WorkLogPanel
                projectId={project.id}
                log={workLog}
                tasks={(s.tasks as never as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }))}
                approvedHours={project.approvedHours ? Number(project.approvedHours) : null}
                canLog={can(_me, PERMISSIONS.PROJECT_READ)}
              />
            ),
          },
          {
            value: "plan",
            label: "Plan",
            count: s.phases.length + s.milestones.length,
            content: (
              <PlanPanel
                projectId={project.id}
                phases={s.phases as never}
                milestones={s.milestones as never}
                users={s.users as never}
                currency={project.currencyCode}
                contractValue={project.contractValue ? String(project.contractValue) : null}
              />
            ),
          },
          {
            value: "deliverables",
            label: "Deliverables",
            content: (
              <DeliverablesPanel
                projectId={project.id}
                milestones={(s.milestones as { id: string; name: string }[]).map((m) => ({ id: m.id, name: m.name }))}
                canManage={canManage}
              />
            ),
          },
          {
            value: "team",
            label: "Team",
            count: s.members.length,
            content: (
              <TeamPanel
                projectId={project.id}
                members={s.members as never}
                users={s.users as never}
                currency={project.currencyCode}
              />
            ),
          },
          {
            value: "raid",
            label: "Risks & issues",
            count: openRisks.length + openIssues.length,
            content: (
              <div className="space-y-6">
                <RaidPanel
                  projectId={project.id}
                  risks={s.risks as never}
                  issues={s.issues as never}
                  users={s.users as never}
                />
                <ChangeRequestsPanel changeRequests={project.changeRequests} />
              </div>
            ),
          },
          {
            value: "details",
            label: "Details",
            content: (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <Row label="Customer">
                      {project.account ? (
                        <>
                          <Link href={`/accounts/${project.account?.id}`} className="text-primary hover:underline">
                            {project.account?.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">{project.account?.accountNumber}</p>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Internal - our own work, no customer</span>
                      )}
                    </Row>
                    <Row label="Project manager">{project.projectManager?.fullName}</Row>
                    <Row label="Sourced from">
                      {project.opportunity ? (
                        <Link href={`/opportunities/${project.opportunity?.id}`} className="text-primary hover:underline">
                          {project.opportunity?.opportunityNumber} - {project.opportunity?.name}
                        </Link>
                      ) : "—"}
                    </Row>
                    <Row label="Contract">
                      {project.contract ? (
                        <Link href="/contracts" className="text-primary hover:underline">
                          {project.contract.contractNumber}
                        </Link>
                      ) : "—"}
                    </Row>
                    {/* Billing type is a customer-payment term; internal work
                        carries a placeholder value that would only mislead. */}
                    {project.projectType !== "INTERNAL" && (
                      <Row label="Billing">{humanize(project.billingType)}</Row>
                    )}
                    {/* Shown whichever type the project is: internal R&D on your
                        own product and customer delivery of it are both worth
                        naming, and the link is what ties this work to the
                        product's cost-to-build. */}
                    {project.product && (
                      <Row label="Product">
                        <Link
                          href={`/products/${project.product.id}`}
                          className="text-primary hover:underline"
                        >
                          {project.product.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {project.product.productCode}
                        </p>
                      </Row>
                    )}
                    <Row label={project.projectType === "INTERNAL" ? "Budget" : "Contract value"}>
                      {formatMoneyTotal(project.contractValue, project.currencyCode)}
                    </Row>
                    <Row label="Schedule">
                      {formatDate(project.startDate)} → {formatDate(project.plannedEndDate)}
                      {project.actualEndDate && (
                        <p className="text-xs text-muted-foreground">
                          Actually ended {formatDate(project.actualEndDate)}
                        </p>
                      )}
                    </Row>
                  </CardContent>
                </Card>

                <div className="space-y-6">
                  {project.scope && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Scope</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="whitespace-pre-wrap text-sm">{project.scope}</p>
                      </CardContent>
                    </Card>
                  )}

                  {project.cases.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Linked support cases</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2 text-sm">
                        {project.cases.map((c: Record<string, any>) => (
                          <div key={c.id} className="flex items-center justify-between gap-2 border-b pb-2 last:border-0">
                            <Link href={`/cases/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">
                              {c.subject}
                              <span className="block text-xs text-muted-foreground">{c.caseNumber}</span>
                            </Link>
                            <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

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
                                {a.oldValue ?? "empty"} → {a.newValue ?? "empty"}
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
              </div>
            ),
          },
          {
            value: "files",
            label: "Notes & files",
            count: notes.length + documents.length,
            content: (
              <div className="grid gap-6 lg:grid-cols-2">
                <NotesSection entityType="Project" entityId={id} notes={notes} />
                <DocumentsPanel entityType="Project" entityId={id} documents={documents} />
                <RecordEmail entityType="Project" entityId={id} />
              </div>
            ),
          },
        ]}
      />
      </ProjectManagementProvider>

    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
