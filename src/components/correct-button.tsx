"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Textarea } from "@/components/ui";
import { openCorrection } from "@/server/corrections";

/**
 * Correct: an administrator says why a processed record needs changing, which
 * opens it for 30 minutes and takes them to its edit page.
 */
export function CorrectButton({ type, id, inline = false }: { type: string; id: string; inline?: boolean }) {
  const [asking, setAsking] = useState(inline);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      const result = await openCorrection({ type, id, reason });
      if (!result.ok) return setError(result.error);
      softGo(result.data.editPath);
    });

  if (!asking) {
    return (
      <Button variant="outline" onClick={() => setAsking(true)}>
        Correct
      </Button>
    );
  }
  return (
    <div className="w-full max-w-xl space-y-2" data-correct-form>
      {error && <Alert tone="danger">{error}</Alert>}
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">What was wrong?</span>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="For example: the claim was entered against the wrong project"
          aria-label="Reason for the correction"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        The reason and every change are kept in the record&apos;s history, and its owner is told. The record stays open for
        30 minutes.
      </p>
      <div className="flex gap-2">
        <Button onClick={submit} disabled={pending || reason.trim().length < 5}>
          {pending ? "Opening…" : "Correct it"}
        </Button>
        {!inline && (
          <Button variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
