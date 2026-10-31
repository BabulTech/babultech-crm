"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Alert, Badge, Button } from "@/components/ui";
import { restoreFromRecycleBin } from "@/server/recycle-bin";
import type { RecycleType } from "@/lib/recycle-types";
import { DeleteConfirm } from "./delete-confirm";

/**
 * Delete, for a record's header: the Super Admin's confirmation, then back to
 * the list. On a record already in the recycle bin it becomes Restore.
 */
export function DeleteRecordButton({
  type,
  id,
  name,
  deleted,
  listPath,
}: {
  type: RecycleType;
  id: string;
  name: string;
  deleted: boolean;
  /** Kept for callers; the confirmation itself says why a delete is held back. */
  blocker?: string | null;
  listPath: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (deleted) {
    return (
      <>
        <Badge tone="danger">In the recycle bin</Badge>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const result = await restoreFromRecycleBin(type, id);
              if (!result.ok) return setError(result.error);
              router.refresh();
            })
          }
        >
          <RotateCcw className="h-4 w-4" /> Restore
        </Button>
        {error && <Alert tone="danger">{error}</Alert>}
      </>
    );
  }

  return <DeleteConfirm type={type} id={id} name={name} variant="button" onDone={() => { softGo(listPath); }} />;
}
