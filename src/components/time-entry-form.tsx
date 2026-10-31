"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { RichTextEditor } from "@/components/rich-text-editor";
import { logTime, updateTimeLog } from "@/server/timesheets";
import { hoursBetween } from "@/lib/work-hours";
import { cn } from "@/lib/utils";

/**
 * The one form for logging time, used everywhere time is logged: My timesheet
 * and a project's Work log. Same fields, same rules, same save, so an entry
 * looks and behaves the same whichever door it came through.
 */

export interface TimeEntryOptions {
  projects: {
    id: string;
    name: string;
    projectNumber: string;
    /** CUSTOMER or INTERNAL. Internal work has no customer to bill. */
    projectType: string;
    tasks: { id: string; name: string; billable: boolean; assignedUserId: string | null }[];
  }[];
  cases: { id: string; caseNumber: string; subject: string }[];
}

export interface EditableTimeEntry {
  id: string;
  workDate: string;
  hours: string;
  startTime: string | null;
  endTime: string | null;
  description: string;
  billable: boolean;
  project: { id: string; name: string; projectNumber?: string } | null;
  projectTask: { id: string; name: string } | null;
  case: { id: string; caseNumber: string; subject: string } | null;
}

/** A TIME column comes back as "09:00:00"; <input type="time"> only takes "09:00". */
export const clockValue = (v: string | null | undefined) => (v ? v.slice(0, 5) : "");

const todayPk = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

export function TimeEntryForm({
  options,
  entry = null,
  lockProjectId,
  defaultDate,
  minDate,
  maxDate,
  onSaved,
  onCancel,
}: {
  options: TimeEntryOptions;
  /** Set when editing; what the time was booked against cannot change. */
  entry?: EditableTimeEntry | null;
  /** On a project's page: the project is fixed and support cases are not offered. */
  lockProjectId?: string;
  defaultDate?: string;
  minDate?: string;
  maxDate?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<"PROJECT" | "CASE">(entry?.case ? "CASE" : "PROJECT");
  const [projectId, setProjectId] = useState(lockProjectId ?? entry?.project?.id ?? "");
  const [taskId, setTaskId] = useState(entry?.projectTask?.id ?? "");
  const [startTime, setStartTime] = useState(clockValue(entry?.startTime));
  const [endTime, setEndTime] = useState(clockValue(entry?.endTime));
  const derivedHours = hoursBetween(startTime, endTime);

  const project = options.projects.find((p) => p.id === projectId);
  const internal = (target === "PROJECT" && project?.projectType === "INTERNAL") || false;
  const lockedOut = lockProjectId && !project;

  function save(fd: FormData) {
    setError(null);
    const get = (k: string) => {
      const v = fd.get(k);
      return v === null || v === "" ? null : String(v);
    };
    const input = {
      projectId: target === "PROJECT" ? projectId || null : null,
      projectTaskId: target === "PROJECT" ? taskId || null : null,
      caseId: target === "CASE" ? get("caseId") : null,
      workDate: get("workDate"),
      hours: derivedHours !== null ? String(derivedHours) : get("hours"),
      startTime: startTime || null,
      endTime: endTime || null,
      description: String(fd.get("description") ?? ""),
      billable: internal ? false : fd.get("billable") === "on",
      completeTask: Boolean(taskId) && fd.get("completeTask") === "on",
    } as never;
    start(async () => {
      const result = entry ? await updateTimeLog(entry.id, input) : await logTime(input);
      if (result.ok) onSaved();
      else setError(result.error);
    });
  }

  if (lockedOut) {
    return <Alert tone="warning">You cannot log time on this project. It must be Planning, Active or At risk, and you must be on its team, be its manager, or have a task on it.</Alert>;
  }

  const bookedAgainst = entry
    ? entry.case
      ? `${entry.case.caseNumber} - ${entry.case.subject}`
      : `${entry.project?.name ?? "Project"}${entry.projectTask ? ` · ${entry.projectTask.name}` : ""}`
    : null;

  return (
    <form action={save} className="space-y-4" data-testid="time-entry-form">
      {error && <Alert tone="danger">{error}</Alert>}

      {bookedAgainst ? (
        <p className="text-sm"><span className="text-muted-foreground">Logged against </span><span className="font-medium">{bookedAgainst}</span></p>
      ) : !lockProjectId && (
        <div className="flex gap-2" role="radiogroup" aria-label="What you worked on">
          {(["PROJECT", "CASE"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={target === t}
              onClick={() => setTarget(t)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                target === t ? "border-primary bg-primary/5 font-medium text-primary" : "hover:bg-accent",
              )}
            >
              {t === "PROJECT" ? "Project work" : "Support case"}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!entry && target === "PROJECT" && (
          <>
            <Field label="Project" required help="The project you worked on. Only projects you are a member of are listed.">
              <Select aria-label="Project" name="projectId" required value={projectId} disabled={Boolean(lockProjectId)}
                onChange={(e) => { setProjectId(e.target.value); setTaskId(""); }}>
                <option value="">Select…</option>
                {options.projects.map((p) => <option key={p.id} value={p.id}>{p.projectNumber} - {p.name}</option>)}
              </Select>
            </Field>
            <Field label="Task" hint={projectId ? undefined : "Pick a project first."} help="The task within the project. Leave it on the project generally if no task fits.">
              <Select aria-label="Task" name="projectTaskId" value={taskId} disabled={!projectId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">The project generally</option>
                {(project?.tasks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          </>
        )}

        {!entry && target === "CASE" && (
          <div className="sm:col-span-2">
            <Field label="Support case" required help="Use this when the time went on a customer issue rather than project work.">
              <Select aria-label="Support case" name="caseId" required>
                <option value="">Select…</option>
                {options.cases.map((c) => <option key={c.id} value={c.id}>{c.caseNumber} - {c.subject}</option>)}
              </Select>
            </Field>
          </div>
        )}

        <Field label="Date" required help="The day you did the work, not the day you are filling this in.">
          <Input aria-label="Date" name="workDate" type="date" required
            defaultValue={entry ? entry.workDate.slice(0, 10) : defaultDate ?? todayPk()}
            min={minDate} max={maxDate ?? todayPk()} />
        </Field>
        <Field label="Started" help="Clock time you began. Optional: fill both times and the hours are worked out for you.">
          <Input aria-label="Started" name="startTime" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field label="Ended" help="Clock time you stopped. An earlier time than the start is read as working past midnight.">
          <Input aria-label="Ended" name="endTime" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
        <Field label="Hours" required={derivedHours === null}
          hint={derivedHours !== null ? `Worked out from the times: ${derivedHours}h` : "Or enter the total directly."}
          help="How long it took, in hours. Filled in for you when both clock times are given.">
          <Input aria-label="Hours" name="hours" type="number" step="0.25" min="0.25" max="24"
            required={derivedHours === null}
            value={derivedHours !== null ? String(derivedHours) : undefined}
            readOnly={derivedHours !== null}
            defaultValue={derivedHours !== null ? undefined : (entry?.hours ?? "")}
            className={derivedHours !== null ? "bg-muted/50" : undefined} />
        </Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <Field label="Details" required help="What the time went on. Use lists and bold for longer write-ups; this is what your approver reads, and what a customer sees if it is billed.">
            <RichTextEditor name="description" rows={5} defaultValue={entry?.description ?? ""}
              placeholder="What you worked on, what you finished, anything blocked…" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2 lg:col-span-4">
          {!internal && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="billable" defaultChecked={entry?.billable ?? false} className="h-4 w-4 rounded border-input" />
              Billable to the customer
            </label>
          )}
          {!entry && target === "PROJECT" && taskId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="completeTask" className="h-4 w-4 rounded border-input" />
              Mark this task complete
            </label>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : entry ? "Save entry" : "Log time"}</Button>
      </div>
    </form>
  );
}
