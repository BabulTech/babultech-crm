"use client";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Textarea } from "@/components/ui";
import { softReload } from "@/components/soft-navigation";
import { requestPartnerChange, withdrawPartnerChange, type PartnerChangeRequest } from "@/server/partner-changes";
import { ChangeList } from "@/components/partner-change-list";

const TEXT_FIELDS = [
  ["displayName", "Partner name"], ["email", "Email"], ["phone", "Phone"], ["website", "Website"],
  ["territory", "Territory"], ["taxNumber", "Tax number"], ["payoutCurrencyCode", "Payout currency"],
] as const;
const PERCENT_FIELDS = [["defaultCommissionPercent", "Commission rate (%)"], ["withholdingTaxPercent", "Withholding tax (%)"]] as const;
const BANK_FIELDS = [["bankName", "Bank"], ["accountTitle", "Account title"], ["accountNumber", "Account number"], ["iban", "IBAN"], ["branch", "Branch"]] as const;

export function ProfileEditor({ state, startEditing = false }: {
  startEditing?: boolean;
  state: {
    isAdmin: boolean;
    current: Record<string, unknown>;
    pending: PartnerChangeRequest | null;
    latest: PartnerChangeRequest | null;
  };
}) {
  const { isAdmin, current, pending, latest } = state;
  const [editing, setEditing] = useState(startEditing && state.isAdmin && !state.pending);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const bank = (current.bankDetails ?? {}) as Record<string, string>;

  function submit(fd: FormData) {
    setError(null);
    const value = (k: string) => String(fd.get(k) ?? "");
    const input = {
      ...Object.fromEntries([...TEXT_FIELDS, ...PERCENT_FIELDS].map(([k]) => [k, value(k)])),
      bankDetails: Object.fromEntries(BANK_FIELDS.map(([k]) => [k, value(k)])),
      reason: value("reason"),
    };
    start(async () => {
      const result = await requestPartnerChange(input);
      if (result.ok) { setEditing(false); softReload(); } else setError(result.error);
    });
  }

  function withdraw(id: string) {
    start(async () => {
      await withdrawPartnerChange(id);
      softReload();
    });
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Your profile
          {isAdmin && !pending && !editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Request a change</Button>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {pending && (
          <div className="space-y-3 rounded-md border p-3" data-testid="partner-change-pending">
            <div className="flex items-center justify-between gap-2">
              <Badge tone="warning">Pending approval</Badge>
              {isAdmin && <Button size="sm" variant="ghost" disabled={busy} onClick={() => withdraw(pending.id)}>Withdraw</Button>}
            </div>
            <ChangeList changes={pending.changes} />
          </div>
        )}
        {latest && !pending && latest.status !== "WITHDRAWN" && (
          <Alert tone={latest.status === "APPROVED" ? "success" : "warning"}>
            Your last change was {latest.status === "APPROVED" ? "approved" : "not approved"}.{latest.decisionNote ? ` ${latest.decisionNote}` : ""}
          </Alert>
        )}
        {!editing && isAdmin && (
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {BANK_FIELDS.map(([k, label]) => <p key={k}><span className="text-muted-foreground">{label}: </span>{bank[k] || "—"}</p>)}
          </div>
        )}
        {!editing && !isAdmin && <p className="text-muted-foreground">Bank details and changes are handled by your portal admin.</p>}
        {editing && (
          <form action={submit} className="space-y-4">
            <Alert tone="info">Your changes will be sent to your admin for approval.</Alert>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              {TEXT_FIELDS.map(([k, label]) => <Field key={k} label={label}><Input aria-label={label} name={k} defaultValue={String(current[k] ?? "")} /></Field>)}
              {PERCENT_FIELDS.map(([k, label]) => <Field key={k} label={label}><Input aria-label={label} name={k} type="number" step="0.01" min="0" max="100" defaultValue={String(current[k] ?? 0)} /></Field>)}
              {BANK_FIELDS.map(([k, label]) => <Field key={k} label={label}><Input aria-label={label} name={k} defaultValue={bank[k] ?? ""} /></Field>)}
              <div className="sm:col-span-2"><Field label="Reason (optional)"><Textarea aria-label="Reason" name="reason" rows={2} /></Field></div>
            </div>
            <p className="text-xs text-muted-foreground">A new commission rate applies to deals registered after approval.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy}>{busy ? "Sending…" : "Submit for approval"}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
