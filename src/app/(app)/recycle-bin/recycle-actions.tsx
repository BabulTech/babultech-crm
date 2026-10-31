"use client";
import { softReload } from "@/components/soft-navigation";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { restoreFromRecycleBin, eraseForGood } from "@/server/recycle-bin";
import type { RecycleType } from "@/lib/recycle-types";

export function RecycleActions({ type, id, name, canErase }: { type: RecycleType; id: string; name: string; canErase: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const result = await fn();
      if (!result.ok && "error" in result) {
        window.alert(result.error);
        router.refresh();
        return;
      }
      softReload();
    });

  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => restoreFromRecycleBin(type, id))}>
        Restore
      </Button>
      {canErase && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Erase ${name} for good?\n\nThis cannot be undone.`)) act(() => eraseForGood(type, id));
          }}
        >
          Erase
        </Button>
      )}
    </div>
  );
}
