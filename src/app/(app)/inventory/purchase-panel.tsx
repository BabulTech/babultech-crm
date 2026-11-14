import Link from "next/link";
import { Plus } from "lucide-react";
import { listAssetsForPurchase } from "@/server/inventory";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, statusTone } from "@/components/ui";
import { formatMoney, humanize } from "@/lib/utils";

/**
 * On an expense or supplier bill: the inventory items it paid for, and how
 * much of it they account for. Hidden from anyone without the inventory
 * permissions, and for anything that bought no items unless they can add some.
 */
export async function PurchasePanel({
  kind,
  id,
  amount,
  currencyCode,
  likelyAssets = false,
}: {
  kind: "expense" | "bill";
  id: string;
  amount: number;
  currencyCode: string;
  /** In the Asset purchase category: offer registering even when empty. */
  likelyAssets?: boolean;
}) {
  const data = await listAssetsForPurchase(kind, id);
  if (!data) return null;
  if (data.items.length === 0 && !(data.canWrite && likelyAssets)) {
    if (!data.canWrite) return null;
    return (
      <div className="mt-6 text-sm text-muted-foreground">
        Bought equipment with this?{" "}
        <Link className="text-primary hover:underline" href={`/inventory/new?${kind === "expense" ? "expenseId" : "billId"}=${id}`}>
          Register it in the inventory
        </Link>
        .
      </div>
    );
  }
  const left = Math.round((amount - data.allocated) * 100) / 100;

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Items bought with this</CardTitle>
        {data.canWrite && left > 0 && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/inventory/new?${kind === "expense" ? "expenseId" : "billId"}=${id}`}>
              <Plus className="h-4 w-4" /> Register as assets
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className={left < 0 ? "text-red-600" : left > 0 ? "text-amber-700" : "text-emerald-700"} data-allocated>
          Put against items: {formatMoney(data.allocated, currencyCode)} of {formatMoney(amount, currencyCode)}
          {left > 0 ? ` - ${formatMoney(left, currencyCode)} not yet registered.` : left < 0 ? " - more than this paid for." : " - fully registered."}
        </p>
        {data.items.length > 0 && (
          <ul className="divide-y">
            {data.items.map((a, i) => (
              <li key={`${a.id}-${i}`} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <Link className="font-mono text-xs text-primary hover:underline" href={`/inventory/${a.id}`}>{a.assetTag}</Link>{" "}
                  {a.name}{a.quantity > 1 ? ` × ${a.quantity}` : ""}{a.viaStock ? " (more stock)" : ""}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge>
                  {formatMoney(a.purchaseCost, a.currencyCode)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
