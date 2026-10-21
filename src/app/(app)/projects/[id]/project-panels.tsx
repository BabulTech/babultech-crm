"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, CornerDownRight, ChevronRight } from "lucide-react";
import {
  createTask, updateTask, changeTaskStatus,
  createPhase, deletePhase,
  createMilestone, completeMilestone,
  addProjectMember, updateProjectMember, removeProjectMember,
  createRisk, createIssue,
} from "@/server/projects";
import {
  Button, Card, CardContent, CardHeader, CardTitle, Field, Input,
  Select, Textarea, Alert, Badge, statusTone, Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { PicklistOptions } from "@/components/picklist";
import { PicklistSelect } from "@/components/picklist-select";
import { cn, formatDate, formatMoney, formatPercent, humanize } from "@/lib/utils";
import { FormDialog } from "@/components/form-dialog";
import { RichTextEditor } from "@/components/rich-text-editor";

import { useProjectManagement, useProjectRates } from "./management-context";

const TASK_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW", "COMPLETED"];
const ALL_TASK_STATUSES = [...TASK_STATUSES, "CANCELLED"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export interface Member {
  id: string;
  userId: string;
  projectRole: string;
  allocationPercent: string | null;
  billingRate: string | null;
  costRate: string | null;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  user: { id: string; fullName: string; jobTitle: string | null; email: string };
}

export interface Task {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  assignedUserId: string | null;
  assignedUser: { id: string; fullName: string } | null;
  phaseId: string | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: string | null;
  completionPercent: string;
  billable: boolean;
  acceptanceCriteria: string | null;
  taskType: string | null;
  /** Set when the task came from a deal: the hours and rate the customer bought. */
  soldHours: string | null;
  soldRate: string | null;
  opportunityProductId: string | null;
  /** Time booked against it, for sold-versus-used. */
  loggedHours?: string | null;
  _count: { subtasks: number };
}

export interface Phase {
  id: string;
  name: string;
  sequenceNumber: number;
  status: string;
  completionPercent: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  budgetedHours: string | null;
}

export interface MilestoneRow {
  id: string;
  name: string;
  dueDate: string;
  completedDate: string | null;
  status: string;
  customerApprovalRequired: boolean;
  customerApprovalDate: string | null;
  billingTrigger: boolean;
  billingAmount: string | null;
  billingPercent: string | null;
  invoicedAt: string | null;
  owner: { id: string; fullName: string } | null;
  phase: { id: string; name: string } | null;
}

interface UserOption {
  id: string;
  fullName: string;
  jobTitle: string | null;
}

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * The task's hours - and, for a task that came from a deal, what was sold.
 *
 * Tasks no longer carry a price. What the customer pays was agreed on the deal;
 * a task from it records the hours and rate SOLD, which are shown here but not
 * editable, because they are the contract rather than the plan. The estimate
 * beside them is the project manager's, and may change.
 */
function TaskCosting({ task }: { task: Task | null }) {
  const sold = task?.soldHours != null;
  return (
    <>
      <Field label={sold ? "Estimated hours" : "Hours"} hint="Also the weight used for progress roll-up."
          help={sold ? "Your plan for the work. The hours sold are shown beside it and do not change." : "How long it takes."}>
        <Input name="estimatedHours" type="number" step="0.5" min="0" defaultValue={task?.estimatedHours ?? ""} />
      </Field>
      {sold && (
        <div className="flex flex-col justify-end pb-2 text-sm">
          <span className="text-muted-foreground">Sold on the deal</span>
          <span className="font-semibold tabular">
            {Number(task!.soldHours)} h @ {formatMoney(task!.soldRate ?? 0)}
          </span>
        </div>
      )}
    </>
  );
}

/** Shared shell for the "click Add, get a form" pattern used across the panels. */
/**
 * An "add one of these" button, and the form it reveals.
 *
 * Every caller but one places this inside a heading row laid out with
 * `flex items-center justify-between`. The button and the form used to be
 * siblings in a fragment, so the form became a flex child of that row: squeezed
 * into the right-hand column, stretching the row to its own height, and floating
 * over the content below. That is the tall empty gap and the overlapping panel
 * these forms kept showing.
 *
 * The fix is a full-width flex item on a wrappable row, rather than a wrapper
 * trying to escape from the inside - a grid or a block placed here is still
 * bound by the column the parent gives it. Those heading rows now carry
 * `flex-wrap`, and `w-full` is what pushes the form onto a line of its own.
 *
 * `order-last` keeps the form beneath both the heading and the button whatever
 * order the caller wrote them in, and `text-left` undoes the alignment it would
 * otherwise inherit from a justify-between row.
 */
function AddSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const canManage = useProjectManagement();
  if (!canManage) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={onToggle}>
        {open ? "Cancel" : <><Plus className="h-4 w-4" /> {label}</>}
      </Button>
      {open && (
        <div className="order-last w-full rounded-md border border-dashed bg-muted/30 p-4 text-left">
          {children}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TaskBoard({
  projectId,
  projectType,
  tasks,
  phases,
  milestones,
  members,
}: {
  projectId: string;
  /**
   * CUSTOMER or INTERNAL. Internal work has no customer to bill, so the
   * billable question is not asked — see the form below and
   * billableForProject() in src/server/projects.ts, which enforces it.
   */
  projectType: string;
  tasks: Task[];
  phases: Phase[];
  milestones: MilestoneRow[];
  members: Member[];
}) {
  const canManage = useProjectManagement();
  const router = useRouter();
  const isInternal = projectType === "INTERNAL";
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "list">("board");
  // Board drag state. Kept here rather than in a separate board component so
  // dropping a card and changing status from the list go through one code path.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  // One expanded parent at a time: opening every parent at once is the wall of
  // cards this replaced.
  const [openSubtasks, setOpenSubtasks] = useState<string | null>(null);
  const [parentFor, setParentFor] = useState<string | null>(null);

  const assignable = members.filter((m) => m.active);
  const topLevel = tasks.filter((t) => !t.parentTaskId);
  const subtasksOf = (id: string) => tasks.filter((t) => t.parentTaskId === id);

  function submitTask(formData: FormData, taskId: string | null, parentTaskId: string | null) {
    setError(null);
    const get = (k: string) => {
      const v = formData.get(k);
      return v === null || v === "" ? null : String(v);
    };

    const input = {
      projectId,
      phaseId: get("phaseId"),
      milestoneId: get("milestoneId"),
      parentTaskId,
      name: String(formData.get("name") ?? ""),
      description: get("description"),
      assignedUserId: get("assignedUserId"),
      status: get("status") ?? "NOT_STARTED",
      priority: get("priority") ?? "MEDIUM",
      startDate: get("startDate"),
      dueDate: get("dueDate"),
      estimatedHours: get("estimatedHours"),
      completionPercent: get("completionPercent"),
      // The checkbox is not rendered for internal work, so an absent field
      // would read as false anyway — this states the intent rather than
      // relying on the markup.
      billable: isInternal ? false : formData.get("billable") === "on",
      acceptanceCriteria: get("acceptanceCriteria"),
      taskType: get("taskType"),
    } as never;

    startTransition(async () => {
      const result = taskId ? await updateTask(taskId, input) : await createTask(input);
      if (result.ok) {
        setAdding(false);
        setEditingId(null);
        setParentFor(null);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function quickStatus(taskId: string, status: string) {
    setError(null);
    startTransition(async () => {
      const result = await changeTaskStatus(taskId, status);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  const taskForm = (task: Task | null, parentTaskId: string | null) => (
    <form action={(fd) => submitTask(fd, task?.id ?? null, parentTaskId)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Task" required
            help="What needs doing, in a few words.">
            <Input name="name" required defaultValue={task?.name} placeholder="Configure the chart of accounts" />
          </Field>
        </div>
        <Field label="Assignee" hint="Must be on the project team."
            help="Who is doing it. It appears in their work list.">
          <Select name="assignedUserId" defaultValue={task?.assignedUserId ?? ""}>
            <option value="">Unassigned</option>
            {assignable.map((m) => (
              <option key={m.userId} value={m.userId}>{m.user?.fullName} - {m.projectRole}</option>
            ))}
          </Select>
        </Field>
        <Field label="Phase"
            help="Which stage of the project this belongs to.">
          <Select name="phaseId" defaultValue={task?.phaseId ?? ""}>
            <option value="">No phase</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>{p.sequenceNumber}. {p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Milestone"
            help="A point the customer recognises - a delivery, a sign-off, a payment trigger.">
          <Select name="milestoneId" defaultValue={task?.milestoneId ?? ""}>
            <option value="">No milestone</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Status"
            help="Where this item stands.">
          <Select name="status" defaultValue={task?.status ?? "NOT_STARTED"}>
            <PicklistOptions list="task_status" fallback={ALL_TASK_STATUSES} within={ALL_TASK_STATUSES} current={task?.status ?? "NOT_STARTED"} />
          </Select>
        </Field>
        <Field label="Priority"
            help="How urgent it is relative to everything else here.">
          <Select name="priority" defaultValue={task?.priority ?? "MEDIUM"}>
            <PicklistOptions list="priority" fallback={PRIORITIES} within={PRIORITIES} current={task?.priority ?? "MEDIUM"} />
          </Select>
        </Field>
        <Field label="Task type"
            help="The kind of work, e.g. Installation, Testing, Data migration. Add one here if it is missing.">
          <PicklistSelect list="task_type" name="taskType" defaultValue={task?.taskType ?? ""} addLabel="Add a task type" />
        </Field>
        <TaskCosting task={task} />
        <Field label="Start date"
            help="When work on this begins.">
          <Input name="startDate" type="date" defaultValue={dateInput(task?.startDate ?? null)} />
        </Field>
        <Field label="Due date"
            help="When it has to be finished by.">
          <Input name="dueDate" type="date" defaultValue={dateInput(task?.dueDate ?? null)} />
        </Field>
        <Field label="Percent complete"
            help="How far along it is. Only meaningful if kept current, so update it or leave it alone.">
          <Input
            name="completionPercent"
            type="number"
            min="0"
            max="100"
            defaultValue={task ? Number(task.completionPercent).toFixed(0) : "0"}
          />
        </Field>
        {/* Internal projects have no customer, so there is nothing to bill and
            nothing to ask. Showing an unticked box would still invite someone
            to tick it. */}
        {!isInternal && (
          <div className="flex items-end">
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                name="billable"
                defaultChecked={task?.billable ?? false}
                className="h-4 w-4 rounded border-input"
              />
              Billable
            </label>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="Description"
            help="The detail that does not fit in the title. Paste from a document or an email and the formatting is kept.">
            <RichTextEditor
              name="description"
              rows={5}
              defaultValue={task?.description ?? ""}
              placeholder="What needs doing, in as much detail as it takes."
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Acceptance criteria" hint="What 'done' means - the thing arguments are avoided with."
            help="What has to be true for this to count as done. Written before the work starts, it prevents the argument at the end.">
            <RichTextEditor
              name="acceptanceCriteria"
              rows={4}
              defaultValue={task?.acceptanceCriteria ?? ""}
              placeholder="What has to be true for this to count as done."
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={closeDialog}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canManage || pending}>
          {pending ? "Saving…" : task ? "Save task" : "Add task"}
        </Button>
      </div>
    </form>
  );

  /**
   * One task card.
   *
   * Rewritten against how ClickUp, Linear and Jira actually draw a board card,
   * because the old one carried six permanently-visible controls - a status
   * select, Edit, Subtask, priority, assignee and billable - on every card. Nine
   * cards made fifty-four competing click targets on one screen, which is a
   * Hick's Law problem before it is a styling one: every card offered the same
   * three decisions, all the time.
   *
   * What changed, and why:
   *
   *   - Actions appear on hover and on keyboard focus, not permanently. The
   *     card carries the title and the one chip that earns its place. This is
   *     progressive disclosure: the board is for scanning, and scanning wants
   *     the title, not the toolbar. `focus-within` keeps them reachable by
   *     keyboard, and the group stays open while a control inside it has focus.
   *
   *   - The status <select> is gone from the board view. Dragging a card between
   *     columns already changes status, through the same action, and a small
   *     select is a far worse target than a whole column (Fitts). The list view
   *     keeps its select, because a list has no columns to drag between.
   *
   *   - Subtasks collapse into a count on the parent instead of each becoming a
   *     card of its own. Eight completed subtasks rendering as eight cards is
   *     what made the Done column longer than the entire rest of the page.
   */
  const taskCard = (t: Task, opts: { isSub?: boolean; draggable?: boolean } = {}) => {
    const { isSub = false, draggable = false } = opts;
    const subtasks = subtasksOf(t.id);
    const doneSubtasks = subtasks.filter((x) => x.status === "COMPLETED").length;
    const expanded = openSubtasks === t.id;

    return (
      <div
        key={t.id}
        // `group` drives the hover/focus reveal below. Without focus-within the
        // actions would be unreachable by keyboard, which is the usual way a
        // hover-only pattern quietly breaks.
        className={cn(
          "group rounded-md border bg-card transition-shadow",
          "hover:shadow-sm focus-within:shadow-sm",
          isSub && "ml-4 border-dashed",
          canManage && draggable && "cursor-grab active:cursor-grabbing",
          dragging === t.id && "opacity-40",
        )}
        draggable={canManage && draggable}
        onDragStart={canManage && draggable ? () => setDragging(t.id) : undefined}
        onDragEnd={canManage && draggable ? () => setDragging(null) : undefined}
      >
        <div className="p-2.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Link
                href={`/projects/${projectId}/tasks/${t.id}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {isSub && <CornerDownRight className="mr-1 inline h-3 w-3 text-muted-foreground" />}
                {t.name}
              </Link>

              {/* Second line only when there is something to say. An
                  "Unassigned · non-billable" line under every card is noise
                  repeated nine times; absence carries the same meaning. */}
              {(t.assignedUser || t.dueDate || t.estimatedHours || t.soldHours) && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[
                    t.assignedUser?.fullName,
                    t.dueDate && `due ${formatDate(t.dueDate)}`,
                    t.estimatedHours && `${Number(t.estimatedHours)}h`,
                    // Sold against used, for a task that came from a deal - the
                    // one figure a project manager needs to see without opening it.
                    t.soldHours != null &&
                      `${Number(t.loggedHours ?? 0)} of ${Number(t.soldHours)}h sold used`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>

            {/* Only CRITICAL and HIGH get a chip. Medium is the default on
                every task here, so a "Medium" badge on all nine cards marked
                nothing - it just spent the colour that should flag the one
                task that is actually urgent. */}
            {(t.priority === "CRITICAL" || t.priority === "HIGH") && (
              <Badge tone={statusTone(t.priority)}>{humanize(t.priority)}</Badge>
            )}
          </div>

          {/* On an internal project every task is non-billable, so the chip
              would appear on every card and mark nothing. It is only news when
              a task differs from what the project would lead you to expect. */}
          {(subtasks.length > 0 || (!t.billable && !isInternal)) && (
            <div className="mt-1.5 flex items-center gap-2">
              {subtasks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setOpenSubtasks(expanded ? null : t.id)}
                  aria-expanded={expanded}
                  className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
                  {doneSubtasks}/{subtasks.length} subtasks
                </button>
              )}
              {!t.billable && !isInternal && (
                <span className="text-xs text-muted-foreground">non-billable</span>
              )}
            </div>
          )}

          {/* Revealed on hover or keyboard focus. `h-0 overflow-hidden` rather
              than `hidden` so the controls stay in the tab order and the card
              does not resize as the pointer crosses it. */}
          <div
            className={cn(
              "flex items-center gap-1 overflow-hidden transition-all",
              "h-0 opacity-0 group-hover:mt-1.5 group-hover:h-7 group-hover:opacity-100",
              "group-focus-within:mt-1.5 group-focus-within:h-7 group-focus-within:opacity-100",
            )}
          >
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
              disabled={!canManage} onClick={() => { setError(null); setAdding(false); setParentFor(null); setEditingId(t.id); }}>
              Edit
            </Button>
            {!isSub && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                disabled={!canManage} onClick={() => { setError(null); setAdding(false); setEditingId(null); setParentFor(t.id); }}>
                Subtask
              </Button>
            )}
            {/* The list view has no columns to drag between, so it keeps a
                status control. The board does not need one. */}
            {!draggable && (
              <Select
                className="h-7 w-auto text-xs"
                value={t.status}
                disabled={!canManage || pending}
                onChange={(e) => quickStatus(t.id, e.target.value)}
              >
                <PicklistOptions list="task_status" fallback={ALL_TASK_STATUSES} within={ALL_TASK_STATUSES} current={t.status} />
              </Select>
            )}
          </div>
        </div>

        {expanded && subtasks.length > 0 && (
          <div className="space-y-1.5 border-t bg-muted/30 p-2">
            {subtasks.map((sub) => taskCard(sub, { isSub: true }))}
          </div>
        )}

        {/* The edit and subtask forms used to render here, inside the card and
            so inside a ~250px board column. They open in a dialog now — see
            FormDialog and the one rendered at the end of this component. */}
      </div>
    );
  };

  // Which task the dialog is for, and in what mode. Editing, adding a subtask
  // and adding a top-level task are the same form, so they share one dialog
  // rather than three near-identical copies.
  // `tasks` holds every task including subtasks, so one lookup covers both.
  const dialogTask = editingId ? (tasks.find((t) => t.id === editingId) ?? null) : null;
  const dialogParent = parentFor ? tasks.find((t) => t.id === parentFor) ?? null : null;
  const dialogOpen = adding || editingId !== null || parentFor !== null;

  const closeDialog = () => {
    setAdding(false);
    setEditingId(null);
    setParentFor(null);
    setError(null);
  };

  return (
    <>
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Tasks</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Completing tasks rolls progress up into phases and the project - the percentage is never typed in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="h-8 w-28 text-xs" value={view} onChange={(e) => setView(e.target.value as never)}>
            <option value="board">Board</option>
            <option value="list">List</option>
          </Select>
          {/* The form opens in a dialog, so nothing but the toggle and this
              button lives in the header. An earlier version rendered the form
              inline here, which stretched the header across the whole board. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canManage}
            onClick={() => { setError(null); setEditingId(null); setParentFor(null); setAdding(true); }}
          >
            {/* Management permission is also checked by the server action. */}
            <Plus className="h-4 w-4" /> Add task
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}

        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tasks yet. Add the first one - until then the project shows 0% because nothing has been planned.
          </p>
        ) : view === "board" ? (
          // Five equal columns that scroll sideways rather than wrapping.
          //
          // `md:grid-cols-3 xl:grid-cols-5` wrapped the five statuses onto two
          // rows at every width between 768px and 1280px, which breaks the one
          // thing a board is for: left-to-right flow. NOT STARTED and COMPLETED
          // ended up stacked above one another, and the second row's columns
          // were a different width from the first.
          //
          // Columns stay equal even when empty, which is what Jira, Trello,
          // Linear and Asana all do. An empty column is still a drop target, so
          // collapsing it would shrink the thing you have to hit while dragging
          // — the Fitts's Law point made below — and columns that resize as
          // cards move make the board jump under the pointer.
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3">
            {TASK_STATUSES.map((status) => {
              // Top-level only. Subtasks live inside their parent card, so a
              // parent with eight completed children is one card here rather
              // than nine spread across two columns.
              const column = topLevel.filter((t) => t.status === status);
              const isTarget = dragOverColumn === status;
              return (
                <div
                  key={status}
                  onDragOver={(e) => { e.preventDefault(); setDragOverColumn(status); }}
                  onDragLeave={() => setDragOverColumn((c) => (c === status ? null : c))}
                  onDrop={(e) => { e.preventDefault(); setDragOverColumn(null); if (dragging) quickStatus(dragging, status); setDragging(null); }}
                  className={cn(
                    "rounded-lg p-2 transition-colors",
                    // The whole column is the drop target, which is the largest
                    // one available - the Fitts's Law argument for dragging over
                    // a per-card select in the first place.
                    isTarget ? "bg-primary/10 ring-1 ring-primary/30" : "bg-muted/40",
                  )}
                >
                  <p className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>{humanize(status)}</span>
                    <span className="font-normal tabular-nums">{column.length}</span>
                  </p>
                  <div className="space-y-2">
                    {column.map((t) => taskCard(t, { draggable: true }))}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {topLevel.map((t) => taskCard(t))}
          </div>
        )}
      </CardContent>
    </Card>

    {/* One dialog for all three cases. A board column is ~250px, which is not
        a place to fill in ten fields — see FormDialog for the whole argument. */}
    <FormDialog
      open={dialogOpen}
      onOpenChange={(o) => { if (!o) closeDialog(); }}
      title={dialogTask ? "Edit task" : dialogParent ? "New subtask" : "New task"}
      description={dialogParent ? `Under “${dialogParent.name}”` : undefined}
    >
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
      {dialogOpen && taskForm(dialogTask, dialogTask ? dialogTask.parentTaskId : parentFor)}
    </FormDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Team / resources
// ---------------------------------------------------------------------------

export function TeamPanel({
  projectId,
  members,
  users,
  currency,
}: {
  projectId: string;
  members: Member[];
  users: UserOption[];
  currency: string;
}) {
  const canManage = useProjectManagement();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const canViewRates = useProjectRates();
  const memberIds = new Set(members.map((m) => m.userId));
  const available = users.filter((u) => !memberIds.has(u.id));

  function add(formData: FormData) {
    setError(null);
    const get = (k: string) => {
      const v = formData.get(k);
      return v === null || v === "" ? null : String(v);
    };
    startTransition(async () => {
      const result = await addProjectMember({
        projectId,
        userId: String(formData.get("userId") ?? ""),
        projectRole: String(formData.get("projectRole") ?? ""),
        allocationPercent: get("allocationPercent"),
        startDate: get("startDate"),
        endDate: get("endDate"),
        ...(canViewRates ? { billingRate: get("billingRate"), costRate: get("costRate") } : {}),

      } as never);
      if (result.ok) { setAdding(false); router.refresh(); }
      else setError(result.error);
    });
  }

  function save(id: string, formData: FormData) {
    setError(null);
    const get = (k: string) => {
      const v = formData.get(k);
      return v === null || v === "" ? null : String(v);
    };
    startTransition(async () => {
      const result = await updateProjectMember(id, {
        projectRole: String(formData.get("projectRole") ?? ""),
        allocationPercent: get("allocationPercent"),
        startDate: get("startDate"),
        endDate: get("endDate"),
        billingRate: get("billingRate"),
        costRate: get("costRate"),
        active: formData.get("active") === "on",
      } as never);
      if (result.ok) { setEditingId(null); router.refresh(); }
      else setError(result.error);
    });
  }

  function remove(id: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await removeProjectMember(id);
      if (result.ok) {
        if (result.data.deactivated) {
          setNotice("They have logged time on this project, so they were deactivated rather than removed - their hours stay attached to them.");
        }
        router.refresh();
      } else setError(result.error);
    });
  }

  const totalAllocation = members
    .filter((m) => m.active)
    .reduce((s, m) => s + Number(m.allocationPercent ?? 0), 0);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-y-3 space-y-0">
        <div>
          <CardTitle>Team</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {members.filter((m) => m.active).length} active · {totalAllocation}% total allocation booked
          </p>
        </div>
        <AddSection label="Add person" open={adding} onToggle={() => setAdding(!adding)}>
          <form action={add} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Person" required
            help="Who is joining the project team.">
                <Select name="userId" required>
                  <option value="">Select…</option>
                  {available.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}{u.jobTitle ? `, ${u.jobTitle}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Role on project" required
            help="What they do here - developer, analyst, tester. Separate from their job title.">
                <Input name="projectRole" required placeholder="Business Analyst" />
              </Field>
              <Field label="Allocation %" hint="Share of their week booked to this project."
            help="How much of their time this project has. 50% means half their week, which matters when they sit on three projects.">
                <Input name="allocationPercent" type="number" min="0" max="100" placeholder="50" />
              </Field>
              <Field label="From"
            help="When they join the project.">
                <Input name="startDate" type="date" />
              </Field>
              <Field label="Until"
            help="When they leave it. Leave empty if they are on it for the duration.">
                <Input name="endDate" type="date" />
              </Field>
              <Field label="Billing rate" hint="Blank uses their standard rate."
            help="What the customer is charged per hour of this person's time on this project.">
                <Input disabled={!canViewRates} name="billingRate" type="number" step="0.01" min="0" />
              </Field>
              <Field label="Cost rate" hint="Blank uses their standard cost."
            help="What this person costs per hour. Used for margin, never shown to the customer.">
                <Input disabled={!canViewRates} name="costRate" type="number" step="0.01" min="0" />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!canManage || pending}>
                {pending ? "Adding…" : "Add to project"}
              </Button>
            </div>
          </form>
        </AddSection>
      </CardHeader>

      <CardContent className="px-0">
        {(error || notice) && (
          <div className="px-5 pb-3">
            {error && <Alert tone="danger">{error}</Alert>}
            {notice && <Alert tone="info">{notice}</Alert>}
          </div>
        )}

        {members.length === 0 ? (
          <p className="px-5 pb-2 text-sm text-muted-foreground">Nobody booked on this project yet.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Role</TH>
                <TH className="text-right">Allocation</TH>
                {canViewRates && <TH className="text-right">Billing rate</TH>}
                {canViewRates && <TH className="text-right">Cost rate</TH>}
                <TH>Window</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {members.map((m) => (
                <Fragment key={m.id}>
                  <TR className={cn(!m.active && "opacity-55")}>
                    <TD>
                      <Link href={`/resources#${m.userId}`} className="font-medium hover:underline">
                        {m.user?.fullName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{m.user?.jobTitle ?? "—"}</p>
                    </TD>
                    <TD className="text-sm">{m.projectRole}</TD>
                    <TD className="text-right tabular">{formatPercent(m.allocationPercent, 0)}</TD>
                    {canViewRates && <TD className="text-right tabular">{formatMoney(m.billingRate, currency)}</TD>}
                    {canViewRates && <TD className="text-right tabular">{formatMoney(m.costRate, currency)}</TD>}
                    <TD className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDate(m.startDate)} → {formatDate(m.endDate)}
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      <Button type="button" variant="ghost" size="sm" disabled={!canManage} onClick={() => setEditingId(editingId === m.id ? null : m.id)}>
                        Edit
                      </Button>
                      <Button type="button" variant="ghost" size="icon" disabled={!canManage || pending} onClick={() => remove(m.id)} aria-label="Remove">
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </TD>
                  </TR>
                  {editingId === m.id && (
                    <TR>
                      <TD colSpan={7} className="bg-muted/30">
                        <form action={(fd) => save(m.id, fd)} className="space-y-4 py-2">
                          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <Field label="Role on project" required>
                              <Input name="projectRole" required defaultValue={m.projectRole} />
                            </Field>
                            <Field label="Allocation %">
                              <Input name="allocationPercent" type="number" min="0" max="100" defaultValue={m.allocationPercent ?? ""} />
                            </Field>
                            <Field label="Billing rate">
                              <Input name="billingRate" type="number" step="0.01" min="0" defaultValue={m.billingRate ?? ""} />
                            </Field>
                            <Field label="Cost rate">
                              <Input name="costRate" type="number" step="0.01" min="0" defaultValue={m.costRate ?? ""} />
                            </Field>
                            <Field label="From">
                              <Input name="startDate" type="date" defaultValue={dateInput(m.startDate)} />
                            </Field>
                            <Field label="Until">
                              <Input name="endDate" type="date" defaultValue={dateInput(m.endDate)} />
                            </Field>
                            <div className="flex items-end">
                              <label className="flex items-center gap-2 pb-2 text-sm">
                                <input type="checkbox" name="active" defaultChecked={m.active} className="h-4 w-4 rounded border-input" />
                                Active on the project
                              </label>
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                            <Button type="submit" size="sm" disabled={!canManage || pending}>Save</Button>
                          </div>
                        </form>
                      </TD>
                    </TR>
                  )}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phases and milestones
// ---------------------------------------------------------------------------

export function PlanPanel({
  projectId,
  phases,
  milestones,
  users,
  currency,
  contractValue,
}: {
  projectId: string;
  phases: Phase[];
  milestones: MilestoneRow[];
  users: UserOption[];
  currency: string;
  contractValue: string | null;
}) {
  const canManage = useProjectManagement();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingPhase, setAddingPhase] = useState(false);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [billingTrigger, setBillingTrigger] = useState(false);

  const get = (fd: FormData, k: string) => {
    const v = fd.get(k);
    return v === null || v === "" ? null : String(v);
  };

  function addPhase(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createPhase({
        projectId,
        name: String(fd.get("name") ?? ""),
        ownerUserId: get(fd, "ownerUserId"),
        plannedStart: get(fd, "plannedStart"),
        plannedEnd: get(fd, "plannedEnd"),
        budgetedHours: get(fd, "budgetedHours"),
      } as never);
      if (result.ok) { setAddingPhase(false); router.refresh(); }
      else setError(result.error);
    });
  }

  function addMilestone(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createMilestone({
        projectId,
        phaseId: get(fd, "phaseId"),
        name: String(fd.get("name") ?? ""),
        description: get(fd, "description"),
        ownerUserId: get(fd, "ownerUserId"),
        dueDate: get(fd, "dueDate"),
        status: "PLANNED",
        customerApprovalRequired: fd.get("customerApprovalRequired") === "on",
        billingTrigger: fd.get("billingTrigger") === "on",
        billingPercent: get(fd, "billingPercent"),
        billingAmount: get(fd, "billingAmount"),
      } as never);
      if (result.ok) { setAddingMilestone(false); setBillingTrigger(false); router.refresh(); }
      else setError(result.error);
    });
  }

  function complete(id: string, needsApproval: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await completeMilestone(id, needsApproval);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  function removePhase(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deletePhase(id);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Phases group the work; milestones are what the customer signs off - and, where marked, what triggers an invoice.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Phases</h4>
            <AddSection label="Add phase" open={addingPhase} onToggle={() => setAddingPhase(!addingPhase)}>
              <form action={addPhase} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Phase name" required
            help="A stage of the project - Discovery, Build, UAT. Tasks and milestones hang off phases.">
                    <Input name="name" required placeholder="Discovery" />
                  </Field>
                  <Field label="Owner"
            help="Who is accountable for this item.">
                    <Select name="ownerUserId">
                      <option value="">Unassigned</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </Select>
                  </Field>
                  <Field label="Budgeted hours">
                    <Input name="budgetedHours" type="number" step="0.5" min="0" />
                  </Field>
                  <Field label="Planned start"
            help="When this phase is due to begin.">
                    <Input name="plannedStart" type="date" />
                  </Field>
                  <Field label="Planned end"
            help="When it is due to finish.">
                    <Input name="plannedEnd" type="date" />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!canManage || pending}>Add phase</Button>
                </div>
              </form>
            </AddSection>
          </div>

          {phases.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phases. Tasks can still be created without one.</p>
          ) : (
            <div className="space-y-2">
              {phases.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-md border p-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">
                    {p.sequenceNumber}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(p.plannedStart)} → {formatDate(p.plannedEnd)}
                      {p.budgetedHours && ` · ${Number(p.budgetedHours)}h budgeted`}
                    </p>
                  </div>
                  <div className="w-28 shrink-0">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${Number(p.completionPercent)}%` }} />
                    </div>
                    <p className="mt-1 text-right text-xs tabular text-muted-foreground">
                      {formatPercent(p.completionPercent, 0)}
                    </p>
                  </div>
                  <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>
                  <Button type="button" variant="ghost" size="icon" disabled={!canManage || pending} onClick={() => removePhase(p.id)} aria-label="Delete phase">
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Milestones</h4>
            <AddSection label="Add milestone" open={addingMilestone} onToggle={() => setAddingMilestone(!addingMilestone)}>
              <form action={addMilestone} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Milestone" required>
                    <Input name="name" required placeholder="UAT sign-off" />
                  </Field>
                  <Field label="Due date" required>
                    <Input name="dueDate" type="date" required />
                  </Field>
                  <Field label="Phase">
                    <Select name="phaseId">
                      <option value="">No phase</option>
                      {phases.map((p) => <option key={p.id} value={p.id}>{p.sequenceNumber}. {p.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Owner">
                    <Select name="ownerUserId">
                      <option value="">Unassigned</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </Select>
                  </Field>
                  <div className="space-y-2 pt-6 sm:col-span-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="customerApprovalRequired" className="h-4 w-4 rounded border-input" />
                      Needs customer sign-off before it can be completed
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="billingTrigger"
                        checked={billingTrigger}
                        onChange={(e) => setBillingTrigger(e.target.checked)}
                        className="h-4 w-4 rounded border-input"
                      />
                      Reaching this milestone triggers an invoice
                    </label>
                  </div>
                  {billingTrigger && (
                    <>
                      <Field label="Bill amount" hint="Or use a percentage instead."
            help="The exact amount this milestone releases, if it is a fixed figure rather than a percentage.">
                        <Input name="billingAmount" type="number" step="0.01" min="0" />
                      </Field>
                      <Field
                        label="Bill % of contract"
                        hint={contractValue ? `Contract value ${formatMoney(contractValue, currency)}` : "No contract value set."}
            help="The share of the contract value this milestone releases for invoicing."
                      >
                        <Input name="billingPercent" type="number" step="0.01" min="0" max="100" />
                      </Field>
                    </>
                  )}
                  <div className="sm:col-span-3">
                    <Field label="Description">
                      <Textarea name="description" rows={2} />
                    </Field>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!canManage || pending}>Add milestone</Button>
                </div>
              </form>
            </AddSection>
          </div>

          {milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">No milestones set.</p>
          ) : (
            <div className="space-y-2">
              {milestones.map((m) => {
                const overdue = !m.completedDate && new Date(m.dueDate) < new Date();
                return (
                  <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{m.name}</p>
                      <p className={cn("text-xs", overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                        due {formatDate(m.dueDate)}
                        {m.phase && ` · ${m.phase?.name}`}
                        {m.owner && ` · ${m.owner?.fullName}`}
                      </p>
                    </div>
                    {m.billingTrigger && (
                      <Badge tone={m.invoicedAt ? "success" : "warning"}>
                        {m.invoicedAt
                          ? "Invoiced"
                          : m.billingAmount
                            ? `Bills ${formatMoney(m.billingAmount, currency)}`
                            : `Bills ${formatPercent(m.billingPercent, 0)}`}
                      </Badge>
                    )}
                    {m.customerApprovalRequired && (
                      <Badge tone={m.customerApprovalDate ? "success" : "neutral"}>
                        {m.customerApprovalDate ? "Signed off" : "Sign-off required"}
                      </Badge>
                    )}
                    <Badge tone={statusTone(m.status)}>{humanize(m.status)}</Badge>
                    {m.status !== "COMPLETED" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!canManage || pending}
                        onClick={() => complete(m.id, m.customerApprovalRequired)}
                      >
                        Complete
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Risks and issues
// ---------------------------------------------------------------------------

export function RaidPanel({
  projectId,
  risks,
  issues,
  users,
}: {
  projectId: string;
  risks: {
    id: string; title: string; description: string; probability: string; impact: string;
    riskScore: number; status: string; targetDate: string | null; mitigationPlan: string | null;
    owner: { id: string; fullName: string };
  }[];
  issues: {
    id: string; title: string; description: string; severity: string; status: string;
    dueDate: string | null; owner: { id: string; fullName: string };
  }[];
  users: UserOption[];
}) {
  const canManage = useProjectManagement();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingRisk, setAddingRisk] = useState(false);
  const [addingIssue, setAddingIssue] = useState(false);

  const get = (fd: FormData, k: string) => {
    const v = fd.get(k);
    return v === null || v === "" ? null : String(v);
  };

  function addRisk(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createRisk({
        projectId,
        title: String(fd.get("title") ?? ""),
        description: String(fd.get("description") ?? ""),
        probability: get(fd, "probability"),
        impact: get(fd, "impact"),
        mitigationPlan: get(fd, "mitigationPlan"),
        ownerUserId: String(fd.get("ownerUserId") ?? ""),
        targetDate: get(fd, "targetDate"),
        status: "OPEN",
      } as never);
      if (result.ok) { setAddingRisk(false); router.refresh(); }
      else setError(result.error);
    });
  }

  function addIssue(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createIssue({
        projectId,
        title: String(fd.get("title") ?? ""),
        description: String(fd.get("description") ?? ""),
        severity: get(fd, "severity"),
        ownerUserId: String(fd.get("ownerUserId") ?? ""),
        resolutionPlan: get(fd, "resolutionPlan"),
        dueDate: get(fd, "dueDate"),
        status: "OPEN",
      } as never);
      if (result.ok) { setAddingIssue(false); router.refresh(); }
      else setError(result.error);
    });
  }

  const scoreTone = (score: number) =>
    score >= 9 ? "danger" : score >= 4 ? "warning" : "neutral";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Risks and issues</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          A risk might happen; an issue already has. Risk score is probability × impact.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Risks ({risks.filter((r) => r.status === "OPEN").length} open)</h4>
            <AddSection label="Log risk" open={addingRisk} onToggle={() => setAddingRisk(!addingRisk)}>
              <form action={addRisk} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="lg:col-span-3">
                    <Field label="Risk" required
            help="Something that might go wrong but has not yet. If it already has, log it as an issue instead.">
                      <Input name="title" required placeholder="Customer's data migration file may not arrive on time" />
                    </Field>
                  </div>
                  <Field label="Probability" required
            help="How likely it is to happen. Multiplied by impact to score the risk.">
                    <Select name="probability" required defaultValue="MEDIUM">
                      <PicklistOptions list="risk_level" fallback={LEVELS} within={LEVELS} />
                    </Select>
                  </Field>
                  <Field label="Impact" required
            help="How bad it would be if it did happen.">
                    <Select name="impact" required defaultValue="MEDIUM">
                      <PicklistOptions list="risk_level" fallback={LEVELS} within={LEVELS} />
                    </Select>
                  </Field>
                  <Field label="Owner" required>
                    <Select name="ownerUserId" required>
                      <option value="">Select…</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </Select>
                  </Field>
                  <Field label="Target date"
            help="When the milestone is due.">
                    <Input name="targetDate" type="date" />
                  </Field>
                  <div className="lg:col-span-3">
                    <Field label="Description" required>
                      <Textarea name="description" rows={2} required />
                    </Field>
                  </div>
                  <div className="lg:col-span-3">
                    <Field label="Mitigation plan"
            help="What you are doing to stop it happening, or to soften it if it does.">
                      <Textarea name="mitigationPlan" rows={2} />
                    </Field>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!canManage || pending}>Log risk</Button>
                </div>
              </form>
            </AddSection>
          </div>

          {risks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No risks logged.</p>
          ) : (
            <div className="space-y-2">
              {risks.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                  <Badge tone={scoreTone(r.riskScore)}>{r.riskScore}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {humanize(r.probability)} probability · {humanize(r.impact)} impact · {r.owner?.fullName}
                      {r.targetDate && ` · by ${formatDate(r.targetDate)}`}
                    </p>
                  </div>
                  <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Issues ({issues.filter((i) => i.status === "OPEN").length} open)</h4>
            <AddSection label="Log issue" open={addingIssue} onToggle={() => setAddingIssue(!addingIssue)}>
              <form action={addIssue} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="lg:col-span-3">
                    <Field label="Issue" required
            help="Something that has already gone wrong and needs resolving.">
                      <Input name="title" required />
                    </Field>
                  </div>
                  <Field label="Severity" required
            help="How much damage it is doing now.">
                    <Select name="severity" required defaultValue="MEDIUM">
                      <PicklistOptions list="risk_level" fallback={LEVELS} within={LEVELS} />
                    </Select>
                  </Field>
                  <Field label="Owner" required>
                    <Select name="ownerUserId" required>
                      <option value="">Select…</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </Select>
                  </Field>
                  <Field label="Due date">
                    <Input name="dueDate" type="date" />
                  </Field>
                  <div className="lg:col-span-3">
                    <Field label="Description" required>
                      <Textarea name="description" rows={2} required />
                    </Field>
                  </div>
                  <div className="lg:col-span-3">
                    <Field label="Resolution plan"
            help="How you intend to fix it, and who is doing that.">
                      <Textarea name="resolutionPlan" rows={2} />
                    </Field>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={!canManage || pending}>Log issue</Button>
                </div>
              </form>
            </AddSection>
          </div>

          {issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No issues logged.</p>
          ) : (
            <div className="space-y-2">
              {issues.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                  <Badge tone={statusTone(i.severity)}>{humanize(i.severity)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{i.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {i.owner?.fullName}
                      {i.dueDate && ` · due ${formatDate(i.dueDate)}`}
                    </p>
                  </div>
                  <Badge tone={statusTone(i.status)}>{humanize(i.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
