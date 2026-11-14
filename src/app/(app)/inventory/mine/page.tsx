import Link from "next/link";
import { listMyEquipment } from "@/server/inventory";
import { PageHeader, Card, CardContent, EmptyState, Badge } from "@/components/ui";
import { formatDate, humanize } from "@/lib/utils";
import { ReceiptButtons } from "./receipt-buttons";

/** What a person has been given. Open to everyone; shows only their own items and no prices. */
export default async function MyEquipmentPage() {
  const rows = await listMyEquipment();
  const pending = rows.filter((r) => r.acceptStatus === "PENDING").length;

  return (
    <>
      <PageHeader
        title="My equipment"
        description="Company items in your care. Confirm each one when you receive it, and tell us if something is wrong."
      />
      {pending > 0 && (
        <p className="mb-4 text-sm font-medium text-amber-700">
          {pending} item{pending === 1 ? " is" : "s are"} waiting for you to confirm you received {pending === 1 ? "it" : "them"}.
        </p>
      )}
      {rows.length === 0 ? (
        <Card><EmptyState title="Nothing in your care" description="When you are given a laptop, phone or anything else the company owns, it shows up here." /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((r) => {
            const a = r.asset as Record<string, string | null> & { type: { name: string } | null };
            return (
              <Card key={r.id} data-mine={a.assetTag}>
                <CardContent className="space-y-2 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link href={`/inventory/${a.id}`} className="font-semibold hover:underline">{a.name}</Link>
                      <div className="text-xs text-muted-foreground">
                        {[a.assetTag, a.type?.name, [a.brand, a.model].filter(Boolean).join(" "), a.serialNumber && `SN ${a.serialNumber}`].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {r.acceptStatus === "PENDING" ? <Badge tone="warning">Confirm receipt</Badge>
                      : r.acceptStatus === "DISPUTED" ? <Badge tone="danger">Problem reported</Badge>
                      : <Badge tone="success">Received</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {Number(r.quantity) > 1 ? `${r.quantity} of them · ` : ""}Given {formatDate(r.assignedAt)} by {r.assignedBy?.fullName ?? "—"}
                    {r.conditionOut ? ` · ${humanize(r.conditionOut)}` : ""}
                  </div>
                  {r.note && <div className="text-sm">{r.note}</div>}
                  {a.warrantyEndsOn && <div className="text-xs text-muted-foreground">Warranty until {formatDate(a.warrantyEndsOn)}</div>}
                  {r.acceptStatus === "DISPUTED" && r.acceptNote && <div className="text-sm text-red-700">You said: {r.acceptNote}</div>}
                  {r.acceptStatus === "PENDING" && <ReceiptButtons assignmentId={r.id} />}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
