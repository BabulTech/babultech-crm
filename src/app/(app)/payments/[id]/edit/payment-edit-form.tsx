"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, Input, Select, Textarea } from "@/components/ui";
import { updatePayment } from "@/server/billing";

const METHODS = [
  ["BANK", "Bank transfer"],
  ["CHEQUE", "Cheque"],
  ["CASH", "Cash"],
  ["CARD", "Card"],
  ["WALLET", "Mobile wallet"],
] as const;

/** Editing a payment: when and how it came in, its reference, and its amount while nothing is allocated. */
export function PaymentEditForm({
  id,
  initial,
  amountLocked,
}: {
  id: string;
  initial: { paymentDate: string; paymentMethod: string; referenceNumber: string; notes: string; amount: string };
  amountLocked: boolean;
}) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const result = await updatePayment(id, {
        paymentDate: v.paymentDate,
        paymentMethod: v.paymentMethod as never,
        referenceNumber: v.referenceNumber,
        notes: v.notes,
        ...(amountLocked ? {} : { amount: Number(v.amount) }),
      });
      if (!result.ok) return setError(result.error);
      softGo(`/payments/${id}`);
    });

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Received on</span>
            <Input id="payment-date" type="date" value={v.paymentDate} onChange={(e) => setV({ ...v, paymentDate: e.target.value })} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">How it was paid</span>
            <Select id="payment-method" value={v.paymentMethod} onChange={(e) => setV({ ...v, paymentMethod: e.target.value })}>
              {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Reference</span>
            <Input id="payment-reference" value={v.referenceNumber} onChange={(e) => setV({ ...v, referenceNumber: e.target.value })} maxLength={100} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Amount</span>
            <Input id="payment-amount" type="number" step="0.01" min="0" value={v.amount} disabled={amountLocked} onChange={(e) => setV({ ...v, amount: e.target.value })} />
            {amountLocked && <span className="block text-xs text-muted-foreground">Allocated to invoices, so the amount stays as it is.</span>}
          </label>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Notes</span>
          <Textarea id="payment-notes" rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </label>
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
      </CardContent>
    </Card>
  );
}
