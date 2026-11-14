import Link from "next/link";
import { notFound } from "next/navigation";
import { getAsset, getInventoryOptions } from "@/server/inventory";
import { requireUser } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone, StatTile, DetailRow, Alert, Button,
  Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { formatMoney, formatDate, formatDateTime, humanize } from "@/lib/utils";
import { AssignPanel, ReturnButton, StatusPanel, StockPanel, NotePanel } from "./asset-actions";
import { ReceiptButtons } from "../mine/receipt-buttons";

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const loaded = await getAsset(id);
  if (!loaded) notFound();
  const { asset: a, full, canWrite } = loaded;
  const v = (k: string) => (a as Record<string, unknown>)[k] as string | null | undefined;
  const options = canWrite ? await getInventoryOptions() : null;
  const closed = ["RETIRED", "LOST", "DISPOSED"].includes(a.status);
  const counted = a.tracking === "QUANTITY";
  const myOpen = loaded.open.filter((o) => o.assigneeUserId === me.id);

  return (
    <>
      <PageHeader
        backTo={full ? "/inventory" : "/inventory/mine"}
        backLabel={full ? "Back to inventory" : "Back to my equipment"}
        title={`${a.assetTag} · ${a.name}`}
        description={[loaded.asset.type && (loaded.asset.type as { name: string }).name, v("brand"), v("model")].filter(Boolean).join(" · ")}
      >
        <Badge tone={statusTone(a.status)}>{humanize(a.status)}</Badge>
        <Badge>{humanize(a.condition)}</Badge>
        {canWrite && (
          <Button asChild variant="outline"><Link href={`/inventory/${id}/edit`}>Edit</Link></Button>
        )}
      </PageHeader>

      {loaded.flags.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {loaded.flags.map((f) => <Badge key={f.code} tone={f.tone}>{f.label}</Badge>)}
        </div>
      )}

      {myOpen.map((o) => o.acceptStatus === "PENDING" && (
        <div key={o.id} className="mb-5">
          <Alert tone="warning">
            <div className="space-y-2">
              <p>This was given to you. Please confirm you received it, or say what is wrong.</p>
              <ReceiptButtons assignmentId={o.id} />
            </div>
          </Alert>
        </div>
      ))}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={counted ? "Quantity" : "Tag"} value={counted ? String(a.quantity) : a.assetTag} sublabel={counted ? `${loaded.inUse} in use · ${loaded.available} free` : v("serialNumber") ? `SN ${v("serialNumber")}` : "No serial number"} />
        <StatTile
          label="With"
          value={loaded.open.length === 0 ? "Nobody" : loaded.open.map((o) => o.user?.fullName ?? o.place?.name ?? "?").join(", ")}
          sublabel={loaded.open.length === 0 ? ((loaded.asset.location as { name: string } | null)?.name ? `Stored: ${(loaded.asset.location as { name: string }).name}` : "In stock") : undefined}
        />
        {full ? (
          <StatTile label="Cost" value={formatMoney(a.purchaseCost, a.currencyCode)} sublabel={loaded.totalSpent !== Number(a.purchaseCost) ? `${formatMoney(loaded.totalSpent, a.currencyCode)} with later stock` : `Bought ${formatDate(a.purchaseDate)}`} />
        ) : (
          <StatTile label="Received" value={formatDate(myOpen[0]?.assignedAt as string | undefined)} />
        )}
        <StatTile
          label={v("licenceExpiresOn") ? "Licence renews" : "Warranty ends"}
          value={v("licenceExpiresOn") ? formatDate(v("licenceExpiresOn")) : v("warrantyEndsOn") ? formatDate(v("warrantyEndsOn")) : "—"}
        />
      </div>

      {canWrite && options && !closed && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Give it out</CardTitle></CardHeader>
            <CardContent>
              <AssignPanel assetId={id} tracking={a.tracking} available={loaded.available} condition={a.condition} locations={options.locations.filter((l) => l.active)} users={options.users} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{counted ? "Stock" : "Repair, retire or dispose"}</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              {counted && <StockPanel assetId={id} options={options} available={loaded.available} />}
              {counted && <hr />}
              <StatusPanel assetId={id} status={a.status} condition={a.condition} />
            </CardContent>
          </Card>
        </div>
      )}
      {canWrite && closed && (
        <div className="mt-6 max-w-xl">
          <Card>
            <CardHeader><CardTitle>Bring it back</CardTitle></CardHeader>
            <CardContent><StatusPanel assetId={id} status={a.status} condition={a.condition} /></CardContent>
          </Card>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader><CardTitle>{full ? "Who has had it" : "Your hand-over"}</CardTitle></CardHeader>
        <CardContent>
          {loaded.assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Never given out.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR><TH>To</TH>{counted && <TH>Qty</TH>}<TH>Given</TH><TH>Receipt</TH><TH>Returned</TH><TH /></TR>
                </THead>
                <TBody>
                  {loaded.assignments.map((s) => (
                    <TR key={s.id}>
                      <TD>
                        {s.user?.fullName ?? (s.place ? `Place: ${s.place.name}` : "—")}
                        {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
                      </TD>
                      {counted && <TD>{s.quantity}</TD>}
                      <TD className="text-sm">
                        {formatDate(s.assignedAt)}
                        <div className="text-xs text-muted-foreground">by {s.assignedBy?.fullName ?? "—"} · {humanize(s.conditionOut ?? "")}</div>
                      </TD>
                      <TD className="text-sm">
                        <Badge tone={statusTone(s.acceptStatus === "DISPUTED" ? "REJECTED" : s.acceptStatus)}>{s.acceptStatus === "DISPUTED" ? "Problem reported" : humanize(s.acceptStatus)}</Badge>
                        {s.acceptNote && <div className="text-xs text-muted-foreground">{s.acceptNote}</div>}
                      </TD>
                      <TD className="text-sm">
                        {s.returnedAt ? (
                          <>
                            {formatDate(s.returnedAt)}
                            <div className="text-xs text-muted-foreground">{humanize(s.conditionIn ?? "")}{s.returnNote ? ` · ${s.returnNote}` : ""}</div>
                          </>
                        ) : <span className="text-muted-foreground">Still has it</span>}
                      </TD>
                      <TD className="text-right">
                        {!s.returnedAt && canWrite && <ReturnButton assignmentId={s.id} label={s.user?.fullName ?? s.place?.name ?? "them"} />}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Category">{(loaded.asset.type as { category?: { name: string } | null } | null)?.category?.name ?? "—"}</DetailRow>
            <DetailRow label="Type">{(loaded.asset.type as { name: string } | null)?.name ?? "—"} {counted ? "(counted)" : "(one by one)"}</DetailRow>
            <DetailRow label="Serial number">{v("serialNumber") ?? "—"}</DetailRow>
            <DetailRow label="Kept at">{(loaded.asset.location as { name: string } | null)?.name ?? "—"}</DetailRow>
            <DetailRow label="Warranty ends">{formatDate(v("warrantyEndsOn"))}</DetailRow>
            <DetailRow label="Licence renews">{formatDate(v("licenceExpiresOn"))}</DetailRow>
            <DetailRow label="Notes">{v("notes") ?? "—"}</DetailRow>
            {full && <DetailRow label="Added">{formatDateTime(v("createdAt"))} by {(loaded.asset.createdBy as { fullName: string } | null)?.fullName ?? "—"}</DetailRow>}
          </CardContent>
        </Card>

        {full && (
          <Card>
            <CardHeader><CardTitle>Purchase</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="How we got it">{humanize(v("acquisition"))}</DetailRow>
              <DetailRow label="Date">{formatDate(a.purchaseDate)}</DetailRow>
              <DetailRow label="Cost">{formatMoney(a.purchaseCost, a.currencyCode)}</DetailRow>
              <DetailRow label="Bought from">{(loaded.asset.supplier as { id: string; name: string } | null) ? <Link className="text-primary hover:underline" href={`/accounts/${(loaded.asset.supplier as { id: string }).id}`}>{(loaded.asset.supplier as { name: string }).name}</Link> : v("supplierName") ?? "—"}</DetailRow>
              <DetailRow label="Invoice / receipt">{v("invoiceReference") ?? "—"}</DetailRow>
              <DetailRow label="Details">{v("purchaseDetails") ?? "—"}</DetailRow>
              <DetailRow label="Paid by">
                {loaded.expense ? (
                  <>
                    <Link className="text-primary hover:underline" href={`/expenses/${loaded.expense.id}`}>{loaded.expense.expenseNumber}</Link>{" "}
                    <Badge tone={statusTone(loaded.expense.approvalStatus)}>{humanize(loaded.expense.approvalStatus)}</Badge>
                    {loaded.expense.approvalStatus === "DRAFT" && <div className="text-xs text-amber-700">Still a draft. Open it, attach the receipt and submit it.</div>}
                  </>
                ) : loaded.bill ? (
                  <>
                    <Link className="text-primary hover:underline" href={`/vendor-bills/${loaded.bill.id}`}>{loaded.bill.billNumber}</Link>{" "}
                    <Badge tone={statusTone(loaded.bill.status)}>{humanize(loaded.bill.status)}</Badge>
                  </>
                ) : v("acquisition") === "PURCHASED" ? (
                  <span className="text-red-600">The expense or bill is missing</span>
                ) : "No money spent"}
              </DetailRow>
            </CardContent>
          </Card>
        )}
      </div>

      {full && (
        <Card className="mt-6">
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {canWrite && <NotePanel assetId={id} />}
            <ul className="space-y-2 text-sm">
              {loaded.events.map((e) => (
                <li key={e.id} className="border-l-2 pl-3">
                  <span className="font-medium">{humanize(e.kind)}</span>
                  {e.quantityChange ? ` ${e.quantityChange > 0 ? "+" : ""}${e.quantityChange}` : ""}
                  {e.cost != null ? ` · ${formatMoney(e.cost, a.currencyCode)}` : ""}
                  {e.expense ? <> · <Link className="text-primary hover:underline" href={`/expenses/${e.expense.id}`}>{e.expense.expenseNumber}</Link></> : null}
                  {e.note ? ` · ${e.note}` : ""}
                  <div className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)} · {e.actor?.fullName ?? "System"}</div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
