"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { deleteImpact, deleteToRecycleBin } from "@/server/recycle-bin";
import type { RecycleType } from "@/lib/recycle-types";

type Impact = { goesWith: string[]; staysBehind: string[]; blocker: string | null };

/**
 * Delete, for the Super Admin: a Delete link that opens a short confirmation
 * on the spot. It says what goes to the recycle bin with the record and what
 * stays, asks why, and only then deletes. The reason is kept in the record's
 * history. When the books hold it back (a closed month, an allocated
 * payment) it says so instead.
 */
export function DeleteConfirm({
  type,
  id,
  name,
  onDone,
  variant = "link",
}: {
  type: RecycleType;
  id: string;
  name: string;
  /** After a successful delete. Defaults to reloading the page. */
  onDone?: () => void;
  /** A link for list rows, a button for a record's header. */
  variant?: "link" | "button";
}) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () =>
    start(async () => {
      setError(null);
      try {
        setImpact(await deleteImpact(type, id));
      } catch {
        setError("Could not check what this would delete. Try again.");
      }
    });

  const confirm = () =>
    start(async () => {
      setError(null);
      const result = await deleteToRecycleBin(type, id, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (onDone) onDone();
      else softReload();
    });

  const trigger =
    variant === "button"
      ? "inline-flex h-9 items-center rounded-md border border-input bg-card px-4 text-sm font-medium text-destructive shadow-sm hover:bg-destructive/5 disabled:opacity-50"
      : "text-sm font-medium text-destructive hover:underline disabled:opacity-50";

  if (!impact) {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <button type="button" className={trigger} disabled={pending} onClick={open} aria-label={`Delete ${name}`}>
          {pending ? "Checking…" : "Delete"}
        </button>
        {error && <span className="max-w-56 text-right text-xs text-destructive" role="alert">{error}</span>}
      </span>
    );
  }

  return (
    <div
      className="w-72 max-w-full space-y-2 rounded-md border border-destructive/40 bg-card p-3 text-left text-sm text-card-foreground shadow-lg"
      role="dialog"
      aria-label={`Delete ${name}`}
      data-delete-confirm
    >
      {impact.blocker ? (
        <>
          <p className="font-medium">{name} cannot be deleted yet.</p>
          <p className="text-muted-foreground">{impact.blocker}</p>
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setImpact(null)}>Close</button>
        </>
      ) : (
        <>
          <p className="font-medium">Delete {name}?</p>
          <p className="text-xs text-muted-foreground">It goes to the recycle bin, where it can be restored for 90 days.</p>
          {impact.goesWith.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goes with it</p>
              <ul className="list-disc pl-5">{impact.goesWith.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
          )}
          {impact.staysBehind.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stays</p>
              <ul className="list-disc pl-5">{impact.staysBehind.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
          )}
          <label className="block">
            <span className="text-xs font-medium">Why is it being deleted?</span>
            <input
              name="deleteReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              autoFocus
              className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder="e.g. Entered twice by mistake"
            />
          </label>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
              disabled={pending || reason.trim().length < 3}
              onClick={confirm}
              aria-label={`Yes, delete ${name}`}
            >
              {pending ? "Deleting…" : "Yes, delete"}
            </button>
            <button type="button" className="text-sm font-medium text-primary hover:underline" disabled={pending} onClick={() => { setImpact(null); setReason(""); }}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
