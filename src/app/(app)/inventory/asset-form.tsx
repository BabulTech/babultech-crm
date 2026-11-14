"use client";

import { useMemo, useState } from "react";
import { Input, Select, Textarea, Alert } from "@/components/ui";
import { RecordForm, FormField } from "@/components/record-form";
import { RecordLookup } from "@/components/record-lookup";

export interface InventoryFormOptions {
  categories: { id: string; name: string; active: boolean }[];
  types: { id: string; name: string; tracking: string; active: boolean; categoryName: string }[];
  locations: { id: string; name: string; active: boolean }[];
  vendors: { id: string; name: string }[];
  currencies: { code: string; name: string }[];
  expenses: { id: string; label: string }[];
  bills: { id: string; label: string }[];
  canRecordExpense: boolean;
  approvesPurchase: boolean;
}

export interface AssetDefaults {
  name?: string | null;
  typeId?: string | null;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  locationId?: string | null;
  condition?: string | null;
  warrantyEndsOn?: string | null;
  licenceExpiresOn?: string | null;
  notes?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: number | string | null;
  currencyCode?: string | null;
  supplierName?: string | null;
  supplierAccountId?: string | null;
  invoiceReference?: string | null;
  purchaseDetails?: string | null;
  paidHow?: string | null;
  expenseId?: string | null;
  vendorBillId?: string | null;
}

type Result =
  | { ok: true; data?: { id: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };

export const CONDITION_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "GOOD", label: "Good" },
  { value: "NEEDS_REPAIR", label: "Needs repair" },
  { value: "BROKEN", label: "Broken" },
];

const PAID_HOW = [
  { value: "COMPANY", label: "Company paid (records a new expense)" },
  { value: "REIMBURSE", label: "Someone paid from their pocket - pay them back (new expense)" },
  { value: "EXPENSE", label: "Already recorded as an expense - link it" },
  { value: "BILL", label: "On a supplier bill - link it" },
  { value: "GIFT", label: "Gift or free - no money spent" },
  { value: "EXISTING", label: "We already had it before this system" },
];

/**
 * Where the money for an item came from. Shared by adding an item and by
 * adding more stock of a counted one.
 */
export function PurchaseFields({
  options,
  defaults,
  count,
  showDate = true,
}: {
  options: InventoryFormOptions;
  defaults?: AssetDefaults;
  count: number;
  showDate?: boolean;
}) {
  const d = defaults ?? {};
  const [paidHow, setPaidHow] = useState(d.paidHow ?? (options.canRecordExpense ? "COMPANY" : "EXPENSE"));
  const [unitCost, setUnitCost] = useState(d.purchaseCost != null ? String(d.purchaseCost) : "");
  const [paidBy, setPaidBy] = useState("");
  const newExpense = paidHow === "COMPANY" || paidHow === "REIMBURSE";
  const noMoney = paidHow === "GIFT" || paidHow === "EXISTING";
  const total = (Number(unitCost) || 0) * (count || 1);

  return (
    <div className="space-y-5 rounded-lg border bg-muted/20 p-4">
      <div>
        <h3 className="text-sm font-semibold">Purchase</h3>
        <p className="text-xs text-muted-foreground">
          The money is kept in Expenses (or Vendor bills) and this item is linked to it, so nothing is counted twice.
        </p>
      </div>

      <FormField label="How was it paid for?" name="paidHow" required help="A new purchase records an expense in the Asset purchase category for you. If the expense or supplier bill is already in the system, link it instead.">
        <Select name="paidHow" value={paidHow} onChange={(e) => setPaidHow(e.target.value)}>
          {PAID_HOW.filter((p) => options.canRecordExpense || !(p.value === "COMPANY" || p.value === "REIMBURSE")).map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </Select>
      </FormField>

      {newExpense && (
        <Alert tone="info">
          Saving records a {total > 0 ? total.toLocaleString() : ""} expense in the <strong>Asset purchase</strong> category
          {options.approvesPurchase ? ", already approved." : " as a draft. Open it from the item and submit it for approval."}{" "}
          Attach the receipt to that expense.
        </Alert>
      )}

      {paidHow === "EXPENSE" && (
        <FormField label="Expense" name="expenseId" required help="The expense that paid for this. One expense can cover several items; the screen stops you putting more against it than it was for.">
          <Select name="expenseId" defaultValue={d.expenseId ?? ""} required>
            <option value="">Choose an expense…</option>
            {options.expenses.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </Select>
        </FormField>
      )}
      {paidHow === "BILL" && (
        <FormField label="Supplier bill" name="vendorBillId" required help="The supplier bill this item was on.">
          <Select name="vendorBillId" defaultValue={d.vendorBillId ?? ""} required>
            <option value="">Choose a bill…</option>
            {options.bills.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </Select>
        </FormField>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        {showDate && (
          <FormField label={noMoney ? "Date we got it" : "Purchase date"} name="purchaseDate" required help="The day it was bought or received. Use your best guess for something we already had.">
            <Input name="purchaseDate" type="date" required defaultValue={d.purchaseDate ?? new Date().toISOString().slice(0, 10)} />
          </FormField>
        )}
        <FormField
          label={noMoney ? "Estimated value of each" : count > 1 ? "Cost of each" : "Cost"}
          name="unitCost"
          required
          hint={count > 1 && total > 0 ? `Total ${total.toLocaleString()} for ${count}.` : undefined}
          help="Including tax. Digits only. For several, the price of one; the total is worked out for you."
        >
          <Input name="unitCost" type="number" step="0.01" min="0" required value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </FormField>
        {newExpense && (
          <FormField label="Currency" name="currencyCode">
            <Select name="currencyCode" defaultValue={d.currencyCode ?? "PKR"}>
              {options.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} - {c.name}</option>)}
            </Select>
          </FormField>
        )}
        {paidHow === "REIMBURSE" && (
          <FormField label="Who paid" name="paidByUserId" hint="Leave empty if it was you." help="The person who is owed this money back.">
            <RecordLookup entity="user" name="paidByUserId" value={paidBy} onChange={(id) => setPaidBy(id ?? "")} emptyLabel="Me" />
          </FormField>
        )}
      </div>

      {!noMoney && (
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Bought from" name="supplierName" required={newExpense} help="The shop or supplier's name.">
            <Input name="supplierName" defaultValue={d.supplierName ?? ""} placeholder="e.g. Hafeez Centre - Ali Computers" />
          </FormField>
          <FormField label="Supplier account" name="supplierAccountId" hint="Optional - if we keep a record for them.">
            <Select name="supplierAccountId" defaultValue={d.supplierAccountId ?? ""}>
              <option value="">None</option>
              {options.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </FormField>
          <FormField label="Invoice / receipt number" name="invoiceReference">
            <Input name="invoiceReference" defaultValue={d.invoiceReference ?? ""} />
          </FormField>
        </div>
      )}

      <FormField label="Purchase details" name="purchaseDetails" required={noMoney} help="Anything worth knowing later: what was included, the order number, why it was bought. For a gift or something we already had, say where it came from.">
        <Textarea name="purchaseDetails" rows={2} defaultValue={d.purchaseDetails ?? ""} />
      </FormField>
    </div>
  );
}

/** The item's own details. */
function ItemFields({
  options,
  defaults,
  editing,
  onType,
  onCount,
  count,
  tracking,
}: {
  options: InventoryFormOptions;
  defaults: AssetDefaults;
  editing: boolean;
  onType: (id: string) => void;
  onCount: (n: number) => void;
  count: number;
  tracking: string | null;
}) {
  const d = defaults;
  const grouped = useMemo(() => {
    const map = new Map<string, InventoryFormOptions["types"]>();
    for (const t of options.types.filter((t) => t.active || t.id === d.typeId)) {
      const list = map.get(t.categoryName) ?? [];
      list.push(t);
      map.set(t.categoryName, list);
    }
    return [...map.entries()];
  }, [options.types, d.typeId]);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField label="Type" name="typeId" required help="What kind of item. Laptops and screens are tracked one by one; bulbs, fans and chairs are counted per place. Add a type under Inventory settings.">
          <Select name="typeId" required defaultValue={d.typeId ?? ""} onChange={(e) => onType(e.target.value)}>
            <option value="">Choose a type…</option>
            {grouped.map(([cat, list]) => (
              <optgroup key={cat} label={cat}>
                {list.map((t) => <option key={t.id} value={t.id}>{t.name}{t.tracking === "QUANTITY" ? " (counted)" : ""}</option>)}
              </optgroup>
            ))}
          </Select>
        </FormField>
        <FormField label="Name" name="name" required help="How people will recognise it, e.g. 'Dell Latitude 5440' or 'LED bulbs 18W'.">
          <Input name="name" required defaultValue={d.name ?? ""} />
        </FormField>
        {!editing && (
          <FormField
            label={tracking === "QUANTITY" ? "How many" : "How many identical items"}
            name="count"
            required
            help={tracking === "QUANTITY"
              ? "The number in this stock line, e.g. 20 bulbs in the Main office."
              : "Several of the same (e.g. 3 laptops) each get their own tag. Fill in each serial number afterwards."}
          >
            <Input name="count" type="number" min="1" max={500} step="1" value={count} onChange={(e) => onCount(Math.max(1, Number(e.target.value) || 1))} />
          </FormField>
        )}
        <FormField label="Brand" name="brand"><Input name="brand" defaultValue={d.brand ?? ""} /></FormField>
        <FormField label="Model" name="model"><Input name="model" defaultValue={d.model ?? ""} /></FormField>
        {tracking !== "QUANTITY" && (
          <FormField label="Serial number" name="serialNumber" hint={count > 1 ? "Add after saving, on each item." : undefined}>
            <Input name="serialNumber" defaultValue={d.serialNumber ?? ""} disabled={!editing && count > 1} />
          </FormField>
        )}
        <FormField label="Kept at" name="locationId" help="Where it lives when nobody has it. Add places under Inventory settings.">
          <Select name="locationId" defaultValue={d.locationId ?? ""}>
            <option value="">Not set</option>
            {options.locations.filter((l) => l.active || l.id === d.locationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </FormField>
        <FormField label="Condition" name="condition">
          <Select name="condition" defaultValue={d.condition ?? "NEW"}>
            {CONDITION_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </FormField>
        <FormField label="Warranty ends" name="warrantyEndsOn" hint="Optional. Shown under Needs attention 30 days before.">
          <Input name="warrantyEndsOn" type="date" defaultValue={d.warrantyEndsOn ?? ""} />
        </FormField>
        <FormField label="Licence / subscription renews" name="licenceExpiresOn" hint="Software only.">
          <Input name="licenceExpiresOn" type="date" defaultValue={d.licenceExpiresOn ?? ""} />
        </FormField>
      </div>
      <FormField label="Notes" name="notes">
        <Textarea name="notes" rows={2} defaultValue={d.notes ?? ""} />
      </FormField>
    </div>
  );
}

export function AssetForm({
  action,
  options,
  defaults,
  submitLabel,
  redirectTo,
  editing = false,
  costLocked = false,
}: {
  action: (values: never) => Promise<Result>;
  options: InventoryFormOptions;
  defaults?: AssetDefaults;
  submitLabel: string;
  redirectTo: string;
  editing?: boolean;
  /** The approved expense or bill fixes the cost. */
  costLocked?: boolean;
}) {
  const d = defaults ?? {};
  const [typeId, setTypeId] = useState(d.typeId ?? "");
  const [count, setCount] = useState(1);
  const tracking = options.types.find((t) => t.id === typeId)?.tracking ?? null;

  return (
    <RecordForm action={action} redirectTo={redirectTo} submitLabel={submitLabel}>
      <ItemFields options={options} defaults={d} editing={editing} onType={setTypeId} onCount={setCount} count={count} tracking={tracking} />
      {editing ? (
        <div className="space-y-5 rounded-lg border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold">Purchase</h3>
          {costLocked && <Alert tone="info">The expense or bill that paid for this is approved, so the cost is fixed. Correct it there.</Alert>}
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField label="Purchase date" name="purchaseDate" required>
              <Input name="purchaseDate" type="date" required defaultValue={d.purchaseDate ?? ""} />
            </FormField>
            <FormField label="Cost" name="purchaseCost" required hint="This item's share of the expense or bill.">
              {costLocked ? (
                <>
                  <Input value={String(d.purchaseCost ?? "")} disabled />
                  <input type="hidden" name="purchaseCost" value={String(d.purchaseCost ?? "")} />
                </>
              ) : (
                <Input name="purchaseCost" type="number" step="0.01" min="0" required defaultValue={String(d.purchaseCost ?? "")} />
              )}
            </FormField>
            <FormField label="Bought from" name="supplierName"><Input name="supplierName" defaultValue={d.supplierName ?? ""} /></FormField>
            <FormField label="Supplier account" name="supplierAccountId">
              <Select name="supplierAccountId" defaultValue={d.supplierAccountId ?? ""}>
                <option value="">None</option>
                {options.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </FormField>
            <FormField label="Invoice / receipt number" name="invoiceReference"><Input name="invoiceReference" defaultValue={d.invoiceReference ?? ""} /></FormField>
          </div>
          <FormField label="Purchase details" name="purchaseDetails">
            <Textarea name="purchaseDetails" rows={2} defaultValue={d.purchaseDetails ?? ""} />
          </FormField>
        </div>
      ) : (
        <PurchaseFields options={options} defaults={d} count={count} />
      )}
    </RecordForm>
  );
}
