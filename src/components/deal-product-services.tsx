"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { Money } from "@/components/money";
import {
  PricedLinesEditor, PricedTotals, emptyRow, num, rowFromLine, rowTotals, type PricedRow,
} from "@/components/priced-lines";
import { saveOpportunityLines, type OpportunityPricing } from "@/server/opportunity-lines";
import type { DealLinesInput } from "@/lib/priced-input";
import type { ActionResult } from "@/server/partners";

/**
 * Opportunity Product Services: what this deal sells.
 *
 * Read-only until "Add Product & Service" is pressed; then every line becomes
 * editable at once, and all of them are saved together. One save for the whole
 * set is deliberate - the deal's amount is the sum of these lines, commission
 * pays on it, and a half-saved set would leave it summing something nobody
 * chose.
 *
 * The editor itself is shared with the deal's quotes (components/priced-lines),
 * because a quote is priced exactly as its deal is and accepting one puts its
 * lines here. The card is shared with the partner portal, which saves through
 * its own action - the partner's deal, checked by the database - and says why
 * a partner can no longer change what was sold.
 */
export function OpportunityProductServices({
  opportunityId,
  pricing,
  canWrite,
  saveLines = saveOpportunityLines,
  lockedNote,
}: {
  opportunityId: string;
  pricing: OpportunityPricing;
  canWrite: boolean;
  /** How the lines are saved. Our team's action unless the portal passes its own. */
  saveLines?: (input: DealLinesInput) => Promise<ActionResult<{ amount: string; lines: number }>>;
  /** Why the lines cannot be changed, shown when they cannot. */
  lockedNote?: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const currency = pricing.currencyCode;
  const lost = pricing.stage === "CLOSED_LOST";

  const fromLines = (): PricedRow[] => pricing.lines.map((l) => rowFromLine(l, true));

  const [bookId, setBookId] = useState(pricing.priceBookId ?? "");
  const [rows, setRows] = useState<PricedRow[]>(fromLines);

  // The book can change only while no saved line depends on it. Rows that were
  // only just added do not count: they have not been priced from anything yet.
  const bookLocked = rows.some((r) => r.id);

  function beginEditing() {
    setError(null);
    const current = fromLines();
    setRows(current.length ? current : [emptyRow()]);
    setBookId(pricing.priceBookId ?? "");
    setEditing(true);
  }

  function cancel() {
    setError(null);
    setEditing(false);
    setRows(fromLines());
    setBookId(pricing.priceBookId ?? "");
  }

  function save() {
    setError(null);
    const usable = rows.filter((r) => r.productId);
    if (usable.length > 0 && !bookId) {
      setError("Choose the price book this deal is priced from first.");
      return;
    }
    start(async () => {
      const result = await saveLines({
        opportunityId,
        priceBookId: bookId || null,
        lines: usable.map((r) => ({
          id: r.id,
          productId: r.productId,
          priceBookEntryId: r.priceBookEntryId,
          quantity: num(r.quantity),
          unitPrice: num(r.unitPrice),
          licenseCost: num(r.licenseCost),
          maintenanceCost: num(r.maintenanceCost),
          cloudCost: num(r.cloudCost),
          aiCost: num(r.aiCost),
          discountPercent: num(r.discountPercent),
          taxRateId: r.taxRateId || null,
        })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // A full reload, deliberately, rather than relying on the refreshed page
      // that the save sends back.
      //
      // In the production build that refreshed page arrives complete but is
      // never shown: the screen keeps the old page and still says "Nothing
      // added yet", which would lead anybody to save again. The cause is in
      // React 19.2 itself (pingSuspendedRoot in react-dom): when a piece of the
      // streamed page resolves at the very moment React attaches its wake-up
      // callback, the wake-up fires in the middle of a render that React has
      // already decided to delay, is ignored, and the update then waits forever
      // for a signal that has already come. Whether it happens depends on how
      // the stream is split into packets, so it showed in production and not in
      // development. A reload does not go through that path, and shows the deal
      // as it now stands, including the value tiles above that depend on these
      // lines.
      softReload();
    });
  }

  const saved = rowTotals(fromLines(), pricing);
  const bookName = pricing.books.find((b) => b.id === pricing.priceBookId)?.name;

  // ---------------------------------------------------------------------------
  // Read-only
  // ---------------------------------------------------------------------------

  if (!editing) {
    return (
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Opportunity Product Services</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {bookName ? (
                <>
                  Priced from <span className="font-medium text-foreground">{bookName}</span>.
                  {saved.hours > 0 && ` ${saved.hours} sold hour(s) become project tasks when the deal is won.`}
                </>
              ) : (
                "Nothing added yet. The deal's value becomes the total of what is added here."
              )}
            </p>
            {!canWrite && lockedNote && (
              <p className="mt-1 text-sm text-muted-foreground">{lockedNote}</p>
            )}
          </div>
          {canWrite && !lost && (
            <Button onClick={beginEditing}>
              <Plus className="h-4 w-4" />
              {pricing.lines.length ? "Edit products & services" : "Add Product & Service"}
            </Button>
          )}
        </CardHeader>

        {pricing.lines.length > 0 && (
          <CardContent className="px-0">
            <Table>
              <THead>
                <TR>
                  <TH>Product / Service</TH>
                  <TH className="text-right">Qty / Hours</TH>
                  <TH className="text-right" priority="secondary">Unit price</TH>
                  <TH className="text-right" priority="tertiary">Costs</TH>
                  <TH className="text-right" priority="secondary">Disc.</TH>
                  <TH className="text-right" priority="tertiary">Tax</TH>
                  <TH className="text-right">Total</TH>
                </TR>
              </THead>
              <TBody>
                {pricing.lines.map((l) => {
                  const hours = l.product?.productType === "SERVICE" && l.product.addInTask;
                  const costs =
                    Number(l.licenseCost) + Number(l.maintenanceCost) + Number(l.cloudCost) + Number(l.aiCost);
                  return (
                    <TR key={l.id}>
                      <TD>
                        <p className="text-sm font-medium">{l.product?.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {l.product?.productCode}
                          {hours && <Badge tone="info" className="ml-2">Becomes a task</Badge>}
                        </p>
                      </TD>
                      <TD className="text-right tabular-nums">
                        {Number(l.quantity)}
                        {hours && <span className="ml-1 text-xs text-muted-foreground">h</span>}
                      </TD>
                      <TD className="text-right" priority="secondary"><Money value={l.unitPrice} currency={currency} stacked /></TD>
                      <TD className="text-right" priority="tertiary">
                        {costs > 0 ? <Money value={costs} currency={currency} stacked /> : "—"}
                      </TD>
                      <TD className="text-right tabular-nums" priority="secondary">
                        {Number(l.discountPercent) > 0 ? `${Number(l.discountPercent)}%` : "—"}
                      </TD>
                      <TD className="text-right tabular-nums" priority="tertiary">
                        {Number(l.taxPercent) > 0 ? `${Number(l.taxPercent)}%` : "—"}
                      </TD>
                      <TD className="text-right font-medium"><Money value={l.lineTotal} currency={currency} stacked /></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            {/* The saved figures, from the database's own totals. */}
            <PricedTotals
              net={pricing.lines.reduce((s, l) => s + Number(l.netTotal), 0)}
              total={pricing.lines.reduce((s, l) => s + Number(l.lineTotal), 0)}
              currency={currency}
              label="Deal total"
            />
          </CardContent>
        )}
      </Card>
    );
  }

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  return (
    <Card className="border-primary/40">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Opportunity Product Services</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Figures come from the price book and every one can be changed. Nothing is saved until you press Save.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={cancel} disabled={pending}>
          <X className="h-4 w-4" /> Cancel
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}

        <PricedLinesEditor
          rows={rows}
          onRowsChange={setRows}
          bookId={bookId}
          onBookChange={setBookId}
          bookLocked={bookLocked}
          bookLockedNote="Locked while this deal has products priced from it. Remove them all to choose a different book."
          bookHelp="One price book per deal. Only active books are offered."
          catalogue={pricing}
          currency={currency}
          disabled={pending}
          totalLabel="Deal total"
        />

        <div className="flex gap-2 border-t pt-4">
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save products & services"}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={pending}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
