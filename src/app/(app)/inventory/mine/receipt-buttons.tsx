"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, AlertTriangle } from "lucide-react";
import { Button, Alert, Textarea } from "@/components/ui";
import { respondToAssignment } from "@/server/inventory";

/** "I received it" or "Something is wrong", for the person an item was given to. */
export function ReceiptButtons({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function send(accept: boolean) {
    setError(null);
    start(async () => {
      const r = await respondToAssignment(assignmentId, accept, note);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      {problem ? (
        <>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong? e.g. charger missing, screen scratched, never received it" />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => send(false)}>Report problem</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setProblem(false)}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={() => send(true)}><Check className="h-4 w-4" /> I received it</Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setProblem(true)}><AlertTriangle className="h-4 w-4" /> Something is wrong</Button>
        </div>
      )}
    </div>
  );
}
