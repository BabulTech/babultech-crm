"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import {
  Card, CardContent, CardFooter, Input, Select, Textarea, Button, Alert, Field,
} from "@/components/ui";
import { RecordLookup } from "@/components/record-lookup";
import { createVendorBill, updateVendorBill } from "@/server/payables";
import { formatMoney, formatMoneyTotal } from "@/lib/utils";

interface Option {
  id: string;
  name: string;
}

export interface BillFormOptions {
  vendors: Option[];
  projects: Option[];
  categories: Option[];
  taxRates: { id: string; name: string; ratePercent: string }[];
  currencies: { code: string; name: string }[];
}

interface Line {
  key: string;
  description: string;
  quantity: string;
  unitCost: string;
  expenseCategoryId: string;
  taxRateId: string;
}

const emptyLine = (): Line => ({
  key: crypto.randomUUID(),
  description: "",
  quantity: "1",
  unitCost: "",
  expenseCategoryId: "",
  taxRateId: "",
});

/**
 * Entering a supplier bill.
 *
 * Totals are shown as the lines are typed, but they are recomputed on the
 * server from the same inputs — what is displayed here is a preview, never the
 * figure that gets stored.
 */
/** A saved bill, when the form edits rather than enters one. */
export interface SavedBill {
  id: string;
  vendorAccountId: string;
  vendorInvoiceNumber: string | null;
  projectId: string | null;
  billDate: string;
  dueDate: string;
  currencyCode: string;
  notes: string | null;
  lines: { description: string; quantity: string; unitCost: string; expenseCategoryId: string | null; taxRateId: string | null }[];
}

export function BillForm({ options, bill }: { options: BillFormOptions; bill?: SavedBill }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>(() =>
    bill?.lines.length
      ? bill.lines.map((l) => ({
          key: crypto.randomUUID(),
          description: l.description,
          quantity: String(l.quantity),
          unitCost: String(l.unitCost),
          expenseCategoryId: l.expenseCategoryId ?? "",
          taxRateId: l.taxRateId ?? "",
        }))
      : [emptyLine()],
  );

  const rateOf = (id: string) =>
    Number(options.taxRates.find((t) => t.id === id)?.ratePercent ?? 0);

  const totals = lines.reduce(
    (acc, line) => {
      const net = (Number(line.quantity) || 0) * (Number(line.unitCost) || 0);
      const tax = (net * rateOf(line.taxRateId)) / 100;
      return { subtotal: acc.subtotal + net, tax: acc.tax + tax };
    },
    { subtotal: 0, tax: 0 },
  );

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit(formData: FormData) {
    setError(null);

    const usable = lines.filter((l) => l.description.trim() && Number(l.unitCost) >= 0);
    if (usable.length === 0) {
      setError("A bill needs at least one line with a description.");
      return;
    }

    start(async () => {
      const save = bill ? (input: never) => updateVendorBill(bill.id, input) : createVendorBill;
      const result = await save({
        vendorAccountId: String(formData.get("vendorAccountId") ?? ""),
        vendorInvoiceNumber: String(formData.get("vendorInvoiceNumber") ?? "") || null,
        projectId: String(formData.get("projectId") ?? "") || null,
        billDate: String(formData.get("billDate") ?? ""),
        dueDate: String(formData.get("dueDate") ?? ""),
        currencyCode: String(formData.get("currencyCode") ?? "PKR"),
        notes: String(formData.get("notes") ?? "") || null,
        lines: usable.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity) || 1,
          unitCost: Number(l.unitCost) || 0,
          expenseCategoryId: l.expenseCategoryId || null,
          taxRateId: l.taxRateId || null,
          projectId: null,
        })),
      } as never);

      if (result.ok) {
        // A full load: see components/log-touch-button.tsx.
        softGo(`/vendor-bills/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  return (
    <form action={submit}>
      <Card>
        <CardContent className="space-y-5 p-6">
          {error && <Alert tone="danger">{error}</Alert>}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Supplier" required
            help="Who is billing you.">
              <Select name="vendorAccountId" required defaultValue={bill?.vendorAccountId ?? ""}>
                <option value="" disabled>
                  Choose a supplier…
                </option>
                {options.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Their invoice number"
            help="The reference the supplier put on their own invoice. Needed to match payments to their records.">
              <Input name="vendorInvoiceNumber" placeholder="As printed on their invoice" defaultValue={bill?.vendorInvoiceNumber ?? ""} />
            </Field>

            <Field label="Bill date" required
            help="The date on the supplier's invoice.">
              <Input name="billDate" type="date" required defaultValue={bill?.billDate?.slice(0, 10) ?? today} />
            </Field>

            <Field label="Due date" required
            help="When you have to pay by. Drives the payables list and what shows as overdue.">
              <Input name="dueDate" type="date" required defaultValue={bill?.dueDate?.slice(0, 10) ?? inThirtyDays} />
            </Field>

            <Field label="Currency"
            help="The currency the supplier billed in.">
              <Select name="currencyCode" defaultValue={bill?.currencyCode ?? "PKR"}>
                {options.currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Project"
            help="The project the cost belongs to, if it was incurred for one.">
              <RecordLookup entity="project" name="projectId" emptyLabel="None" defaultValue={bill?.projectId ?? null} />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Lines</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setLines((c) => [...c, emptyLine()])}
              >
                <Plus className="h-3.5 w-3.5" /> Add line
              </Button>
            </div>

            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={line.key} className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                    <Input
                      value={line.description}
                      onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      placeholder="What the supplier charged for"
                      className="flex-1"
                      aria-label={`Line ${index + 1} description`}
                    />
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                        aria-label={`Remove line ${index + 1}`}
                        className="mt-2 shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-4">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      placeholder="Qty"
                      aria-label={`Line ${index + 1} quantity`}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.unitCost}
                      onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                      placeholder="Unit cost"
                      aria-label={`Line ${index + 1} unit cost`}
                    />
                    <Select
                      value={line.expenseCategoryId}
                      onChange={(e) => updateLine(line.key, { expenseCategoryId: e.target.value })}
                      aria-label={`Line ${index + 1} category`}
                    >
                      <option value="">No category</option>
                      {options.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={line.taxRateId}
                      onChange={(e) => updateLine(line.key, { taxRateId: e.target.value })}
                      aria-label={`Line ${index + 1} tax`}
                    >
                      <option value="">No tax</option>
                      {options.taxRates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Field label="Notes"
            help="Anything worth knowing when this comes up for payment.">
            <Textarea name="notes" rows={2} placeholder="Anything worth recording about this bill." defaultValue={bill?.notes ?? ""} />
          </Field>

          <dl className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular">{formatMoney(totals.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular">{formatMoney(totals.tax)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1 font-medium">
              <dt>Total</dt>
              <dd className="tabular">{formatMoneyTotal(totals.subtotal + totals.tax)}</dd>
            </div>
          </dl>
        </CardContent>

        <CardFooter className="flex justify-end gap-2 border-t bg-muted/30 p-4">
          <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : bill ? "Save changes" : "Create bill"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
