"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Textarea } from "@/components/ui";
import { decideDeliverable } from "@/server/deliverables";

/** Approve a deliverable, or say what needs to change. */
export function DeliverableDecision({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [comment, setComment] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A full reload after deciding: see components/log-touch-button.tsx.
  const decide = (approve: boolean) =>
    start(async () => {
      setError(null);
      const result = await decideDeliverable(id, approve, comment);
      if (!result.ok) return setError(result.error);
      softReload();
    });

  return (
    <div className="mt-3 space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      {asking ? (
        <>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should be changed?" aria-label={`Changes to ${name}`} />
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !comment.trim()} onClick={() => decide(false)}>Send back for changes</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => decide(true)}>Approve</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setAsking(true)}>Ask for changes</Button>
        </div>
      )}
    </div>
  );
}
