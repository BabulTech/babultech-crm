import Link from "next/link";
import { notFound } from "next/navigation";
import { RichText } from "@/components/rich-text";
import { richTextToPlain } from "@/lib/rich-text";
import { ArrowLeft, ListTree, Clock } from "lucide-react";
import { getTask } from "@/server/projects";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { getAuditTrail } from "@/lib/audit";
import { NotesSection } from "@/components/notes-section";
import { DocumentsPanel } from "@/components/documents-panel";
import { AuditPanel } from "@/components/audit-panel";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, DetailRow, Alert, Button, Forbidden,
} from "@/components/ui";
import { formatDate, formatNumber, formatPercent, humanize } from "@/lib/utils";
import { TaskProgress } from "@/app/(app)/my-work/task-progress";

/**
 * A task as a record in its own right.
 *
 * The project board shows a task as a row, which is enough to see it and not
 * enough to work it: the acceptance criteria, the time booked against it, its
 * subtasks and the discussion all had nowhere to live. Notes and documents hang
 * off it like any other record.
 */
export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROJECT_READ)) return <Forbidden what="projects" />;

  const { id: projectId, taskId } = await params;

  const [task, notes, documents, audit] = await Promise.all([
    getTask(taskId),
    listNotes("ProjectTask", taskId),
    listDocuments("ProjectTask", taskId),
    getAuditTrail("ProjectTask", taskId, 15),
  ]);

  if (!task) notFound();

  // A task reached through the wrong project's URL would show correct data
  // under a misleading breadcrumb.
  if (task.project?.id !== projectId) notFound();

  const loggedHours = (task.timeLogs as Record<string, any>[]).reduce(
    (sum, l) => sum + Number(l.hours ?? 0),
    0,
  );
  const estimated = Number(task.estimatedHours ?? 0);
  const overEstimate = estimated > 0 && loggedHours > estimated;

  const subtasks = task.subtasks as Record<string, any>[];
  const subtasksDone = subtasks.filter((s) => s.status === "COMPLETED").length;

  const overdue =
    task.dueDate &&
    !["COMPLETED", "CANCELLED"].includes(task.status as string) &&
    new Date(task.dueDate as string) < new Date();

  const isMine = task.assignedUserId === me.id;

  return (
    <>
      <PageHeader
        backTo={`/projects/${projectId}`}
        backLabel={(task.project?.name as string) ?? "Back to the project"}
        title={task.name as string}
        description={
          [task.phase?.name, task.milestone?.name].filter(Boolean).join(" · ") ||
          "Not assigned to a phase"
        }
      >
        <Badge tone={statusTone(task.status as string)}>{humanize(task.status as string)}</Badge>
        <Badge tone={statusTone(task.priority as string)}>
          {humanize(task.priority as string)}
        </Badge>
        {task.billable ? <Badge tone="info">Billable</Badge> : null}
        {task.project?.projectType === "INTERNAL" ? (
          <Badge tone="neutral">Internal</Badge>
        ) : null}
      </PageHeader>

      {task.status === "BLOCKED" && (
        <div className="mb-5">
          <Alert tone="warning">
            This task is blocked. Whatever is holding it up belongs in the notes below - a blocked
            task with no reason recorded stays blocked.
          </Alert>
        </div>
      )}

      {overdue && (
        <div className="mb-5">
          <Alert tone="danger">
            Due {formatDate(task.dueDate)} and still open.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Progress"
          value={formatPercent(Number(task.completionPercent ?? 0), 0)}
          sublabel={subtasks.length ? `${subtasksDone} of ${subtasks.length} subtasks done` : undefined}
          tone="info"
        />
        <StatTile
          label="Hours logged"
          value={formatNumber(loggedHours, 1)}
          sublabel={estimated > 0 ? `of ${formatNumber(estimated, 1)} estimated` : "No estimate"}
          tone={overEstimate ? "danger" : "neutral"}
        />
        <StatTile
          label="Assigned to"
          value={task.assignedUser?.fullName ?? "Nobody"}
          tone={task.assignedUser ? "neutral" : "warning"}
        />
        <StatTile
          label="Due"
          value={task.dueDate ? formatDate(task.dueDate) : "No date"}
          tone={overdue ? "danger" : "neutral"}
        />
      </div>

      {isMine && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Move it along</CardTitle>
          </CardHeader>
          <CardContent>
            <TaskProgress
              taskId={taskId}
              status={task.status as string}
              completionPercent={Number(task.completionPercent ?? 0)}
            />
          </CardContent>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Project">
              <Link href={`/projects/${projectId}`} className="text-primary hover:underline">
                {task.project?.name}
              </Link>
            </DetailRow>
            <DetailRow label="Phase">{task.phase?.name ?? "—"}</DetailRow>
            <DetailRow label="Milestone">{task.milestone?.name ?? "—"}</DetailRow>
            <DetailRow label="Parent task">
              {task.parentTask ? (
                <Link
                  href={`/projects/${projectId}/tasks/${task.parentTask.id}`}
                  className="text-primary hover:underline"
                >
                  {task.parentTask.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Starts">{task.startDate ? formatDate(task.startDate) : "—"}</DetailRow>
            <DetailRow label="Completed">
              {task.completedDate ? formatDate(task.completedDate) : "—"}
            </DetailRow>
            {/* On internal work there is no customer to bill, so "No" would be
                restating the project type rather than telling the reader
                anything. The Internal badge in the header already says it. */}
            {task.project?.projectType !== "INTERNAL" && (
              <DetailRow label="Billable">
                {task.billable ? "Yes - time bills to the customer" : "No"}
              </DetailRow>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListTree className="h-4 w-4 text-muted-foreground" />
              Subtasks
              {subtasks.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  {subtasksDone} of {subtasks.length}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {subtasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No subtasks. Break the work down on the project board when a task is too big to
                estimate honestly.
              </p>
            ) : (
              <ul className="space-y-2">
                {subtasks.map((s) => (
                  <li
                    key={String(s.id)}
                    className="flex items-center justify-between gap-3 border-b pb-2 text-sm last:border-0 last:pb-0"
                  >
                    <Link
                      href={`/projects/${projectId}/tasks/${s.id}`}
                      className={`min-w-0 flex-1 truncate hover:underline ${
                        s.status === "COMPLETED" ? "text-muted-foreground line-through" : ""
                      }`}
                    >
                      {s.name}
                    </Link>
                    <span className="shrink-0 text-xs tabular text-muted-foreground">
                      {formatPercent(Number(s.completionPercent ?? 0), 0)}
                    </span>
                    <Badge tone={statusTone(s.status)}>{humanize(s.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {(task.description || task.acceptanceCriteria) && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>What done looks like</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {task.description ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Description
                </p>
                {/* RichText decides how to show it: markup as markup, and the
                    plain descriptions written before this field held HTML as
                    pre-wrapped text with their line breaks intact. */}
                <RichText value={task.description as string} className="mt-1" />
              </div>
            ) : null}
            {task.acceptanceCriteria ? (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Acceptance criteria
                </p>
                <RichText value={task.acceptanceCriteria as string} className="mt-1" />
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Time booked
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {(task.timeLogs as Record<string, any>[]).length === 0 ? (
            <p className="px-5 pb-2 text-sm text-muted-foreground">
              No time logged against this task yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Who</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Hours</TH>
                  <TH>What was done</TH>
                  <TH>Approval</TH>
                </TR>
              </THead>
              <TBody>
                {(task.timeLogs as Record<string, any>[]).map((l) => (
                  <TR key={String(l.id)}>
                    <TD className="text-sm">{l.user?.fullName ?? "—"}</TD>
                    <TD className="whitespace-nowrap text-sm">{formatDate(l.workDate)}</TD>
                    <TD className="text-right tabular">{formatNumber(l.hours, 2)}</TD>
                    <TD className="max-w-[280px] truncate text-sm text-muted-foreground">
                      {richTextToPlain(l.description)}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(l.approvalStatus)}>
                        {humanize(l.approvalStatus)}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="ProjectTask" entityId={taskId} notes={notes} />
        <DocumentsPanel entityType="ProjectTask" entityId={taskId} documents={documents} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}
