"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { sendInvoice, writeOffInvoice } from "@/server/billing";
import {
  Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Alert,
} from "@/components/ui";
import { formatMoney } from "@/lib/utils";

const EDITABLE = ["DRAFT", "APPROVED"];

export function InvoiceActions({
  invoiceId,
  status,
  outstanding,
  currency,
}: {
  invoiceId: string;
  status: string;
  outstanding: string;
  currency: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writingOff, setWritingOff] = useState(false);

  const outstandingNumber = Number(outstanding);

  function send() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await sendInvoice(invoiceId);
      if (result.ok) {
        setNotice("Marked as issued. Nothing has been emailed - use the Email panel to send it.");
        // A full load: in the production build a refreshed page can arrive and
        // not be shown (see components/log-touch-button.tsx).
        window.setTimeout(() => softReload(), 800);
      } else setError(result.error);
    });
  }

  function writeOff(formData: FormData) {
    setError(null);
    setNotice(null);
    const amount = Number(formData.get("amount"));
    const reason = String(formData.get("reason") ?? "");
    startTransition(async () => {
      const result = await writeOffInvoice(invoiceId, amount, reason);
      if (result.ok) {
        setNotice("Written off.");
        setWritingOff(false);
        // A full load: in the production build a refreshed page can arrive and
        // not be shown (see components/log-touch-button.tsx).
        window.setTimeout(() => softReload(), 800);
      } else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {EDITABLE.includes(status) ? (
          <>
            <p className="text-sm text-muted-foreground">
              Still a draft. Issuing it stamps any linked milestone as invoiced.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="font-medium text-foreground">It does not email the customer.</strong>{" "}
              Issuing records that the invoice has gone out; sending it is the separate
              Email panel below.
            </p>
            <Button className="w-full" disabled={pending} onClick={send}>
              {pending ? "Working…" : "Mark as issued"}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Marked as issued and no longer editable. Apply cash from the{" "}
            <a href="/payments/new" className="text-primary hover:underline">payments</a> screen.
          </p>
        )}

        {outstandingNumber > 0 && !EDITABLE.includes(status) && (
          <>
            <Button
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={() => setWritingOff(!writingOff)}
            >
              {writingOff ? "Cancel write-off" : "Write off a balance"}
            </Button>
            {writingOff && (
              <form action={writeOff} className="space-y-3 rounded-md border bg-muted/30 p-3">
                <Field label="Amount" hint={`${formatMoney(outstanding, currency)} outstanding`}>
                  <Input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={outstandingNumber}
                    required
                    defaultValue={outstanding}
                  />
                </Field>
                <Field label="Reason" hint="Goes on the invoice's record permanently.">
                  <Input name="reason" required placeholder="Customer in liquidation" />
                </Field>
                <Button type="submit" variant="destructive" size="sm" className="w-full" disabled={pending}>
                  Confirm write-off
                </Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
