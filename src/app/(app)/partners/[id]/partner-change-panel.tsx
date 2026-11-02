"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui";
import { softReload } from "@/components/soft-navigation";
import { ChangeList } from "@/components/partner-change-list";
import { decidePartnerChange, type PartnerChangeRequest } from "@/server/partner-changes";

export function PartnerChangePanel({ request }: { request: PartnerChangeRequest }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function decide(approve: boolean) {
    setError(null);
    start(async () => {
      const result = await decidePartnerChange(request.id, approve, note);
      if (result.ok) softReload();
      else setError(result.error);
    });
  }

  return (
    <Card className="mb-6 border-warning" data-testid="partner-change-panel">
      <CardHeader><CardTitle>Profile change waiting for approval</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {request.changes.bankDetails && <Alert tone="warning">This changes where payouts go. Confirm it with the partner by a known phone number before approving.</Alert>}
        <p className="text-muted-foreground">Requested by {request.requestedByName}.{request.reason ? ` Reason: ${request.reason}` : ""}</p>
        <ChangeList changes={request.changes} />
        <Textarea aria-label="Decision note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the partner (required to reject)" />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(false)}>Reject</Button>
          <Button size="sm" disabled={busy} onClick={() => decide(true)}>Approve</Button>
        </div>
      </CardContent>
    </Card>
  );
}
