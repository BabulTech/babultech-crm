"use client";
import { softGo } from "@/components/soft-navigation";

import { DeleteConfirm } from "@/components/delete-confirm";
import { useCan } from "@/components/permissions";

/** Delete, for the Super Admin: the shared confirmation, then back to the list. */
export function DeleteProjectButton({ projectId, name }: { projectId: string; name: string }) {
  const canDelete = useCan("record:delete");
  if (!canDelete) return null;
  return <DeleteConfirm type="Project" id={projectId} name={name} variant="button" onDone={() => { softGo("/projects"); }} />;
}
