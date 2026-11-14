import Link from "next/link";
import { Plus, Upload, Boxes, Coins, UserCheck, Warehouse, AlertTriangle, Settings2 } from "lucide-react";
import { listAssets, getInventorySummary, getInventoryOptions } from "@/server/inventory";
import { requireUser, can, canAny, PERMISSIONS } from "@/lib/authz";
import { ListFilters } from "@/components/list-filters";
import {
  PageHeader, Card, EmptyState, StatTile, Button, Forbidden, Badge, statusTone, Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { formatMoney, formatMoneyTotal, humanize } from "@/lib/utils";

const STATUSES = ["IN_STOCK", "ASSIGNED", "IN_REPAIR", "RETIRED", "LOST", "DISPOSED"];

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; categoryId?: string; typeId?: string; status?: string; holder?: string; locationId?: string; view?: string }>;
}) {
  const me = await requireUser();
  if (!canAny(me, PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_WRITE)) return <Forbidden what="the inventory" />;

  const params = await searchParams;
  const attention = params.view === "attention";
  const [rows, summary, options] = await Promise.all([
    listAssets({
      search: params.search, categoryId: params.categoryId, typeId: params.typeId, status: params.status,
      holderUserId: params.holder, locationId: params.locationId, attention,
    }),
    getInventorySummary(),
    getInventoryOptions(),
  ]);
  const canWrite = can(me, PERMISSIONS.ASSET_WRITE);
  const filtered = Boolean(params.search || params.categoryId || params.typeId || params.status || params.holder || params.locationId);
  const tab = (view: string | null, label: string, count?: number) => {
    const active = (view === "attention") === attention;
    const q = new URLSearchParams(Object.entries({ ...params, view: view ?? "" }).filter(([, v]) => v) as [string, string][]);
    return (
      <Link
        href={`/inventory${q.toString() ? `?${q}` : ""}`}
        className={`rounded-md border px-3 py-1.5 text-sm font-medium ${active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
      >
        {label}{count != null ? ` (${count})` : ""}
      </Link>
    );
  };

  return (
    <>
      <PageHeader title="Inventory" description="Everything the company owns, who or where has it, and what it cost.">
        {canWrite && (
          <>
            <Button asChild variant="outline">
              <Link href="/inventory/settings"><Settings2 className="h-4 w-4" /> Types and places</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/inventory/import"><Upload className="h-4 w-4" /> Import from Excel</Link>
            </Button>
            <Button asChild>
              <Link href="/inventory/new"><Plus className="h-4 w-4" /> Add item</Link>
            </Button>
          </>
        )}
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={<Boxes className="h-4 w-4" />} label="Items owned" value={String(summary.items)} sublabel={`${summary.records} record${summary.records === 1 ? "" : "s"}`} />
        <StatTile
          icon={<Coins className="h-4 w-4" />}
          label="Purchase value"
          value={summary.value.length ? summary.value.map((v) => formatMoneyTotal(v.total, v.currency)).join(" + ") : formatMoneyTotal(0)}
          sublabel="What we paid; not depreciated"
        />
        <StatTile icon={<UserCheck className="h-4 w-4" />} label="In use" value={String(summary.inUse)} sublabel={summary.pending ? `${summary.pending} awaiting receipt` : "With people or places"} tone={summary.pending ? "warning" : "neutral"} />
        <StatTile icon={<Warehouse className="h-4 w-4" />} label="In stock" value={String(summary.inStock)} sublabel="Free to give out" />
        <StatTile
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Needs attention"
          value={String(summary.attention)}
          sublabel="Warranty, licence, repair, age"
          tone={summary.attention ? "warning" : "success"}
          href="/inventory?view=attention"
        />
      </div>

      <div className="mt-6 mb-4 flex flex-wrap gap-2">
        {tab(null, "Everything")}
        {tab("attention", "Needs attention", summary.attention)}
      </div>

      <ListFilters
        searchPlaceholder="Search name, tag, serial, brand…"
        searchValue={params.search}
        selects={[
          { name: "categoryId", allLabel: "Any category", value: params.categoryId, options: options.categories.map((c) => ({ value: c.id, label: c.name })) },
          { name: "typeId", allLabel: "Any type", value: params.typeId, options: options.types.map((t) => ({ value: t.id, label: t.name })) },
          { name: "status", allLabel: "Any status", value: params.status, options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
          { name: "holder", allLabel: "Anyone", value: params.holder, options: options.users.map((u) => ({ value: u.id, label: u.fullName })) },
          { name: "locationId", allLabel: "Any place", value: params.locationId, options: options.locations.map((l) => ({ value: l.id, label: l.name })) },
        ]}
      >
        {attention && <input type="hidden" name="view" value="attention" />}
      </ListFilters>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title={attention ? "Nothing needs attention" : filtered ? "Nothing matches those filters" : "Nothing in the inventory yet"}
            description={attention ? "No warranties or licences ending soon, nothing broken, nothing past its useful life." : filtered ? "Try different filters." : "Add laptops, screens, fans, bulbs, software - everything the company owns."}
            action={!filtered && !attention && canWrite ? <Button asChild><Link href="/inventory/new">Add the first item</Link></Button> : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Tag</TH>
                  <TH>Item</TH>
                  <TH>With</TH>
                  <TH className="text-right">Qty</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Cost</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id} data-asset={r.assetTag}>
                    <TD className="whitespace-nowrap font-mono text-xs">
                      <Link href={`/inventory/${r.id}`} className="text-primary hover:underline">{r.assetTag}</Link>
                    </TD>
                    <TD>
                      <Link href={`/inventory/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                      <div className="text-xs text-muted-foreground">
                        {[r.type?.category?.name, r.type?.name, [r.brand, r.model].filter(Boolean).join(" "), r.serialNumber && `SN ${r.serialNumber}`].filter(Boolean).join(" · ")}
                      </div>
                      {r.flags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.flags.map((f) => <Badge key={f.code} tone={f.tone}>{f.label}</Badge>)}
                        </div>
                      )}
                    </TD>
                    <TD className="text-sm">
                      {r.holders.length === 0 ? (
                        <span className="text-muted-foreground">{r.location?.name ? `Stored: ${r.location.name}` : "Nobody"}</span>
                      ) : (
                        r.holders.map((h) => (
                          <div key={h.assignmentId}>
                            {h.isPlace ? <span className="text-xs text-muted-foreground">Place: </span> : null}{h.name}{r.tracking === "QUANTITY" ? ` × ${h.quantity}` : ""}
                            {h.acceptStatus === "PENDING" && <span className="ml-1 text-xs text-amber-600">(not yet confirmed)</span>}
                          </div>
                        ))
                      )}
                    </TD>
                    <TD className="text-right text-sm whitespace-nowrap">
                      {r.tracking === "QUANTITY" ? (
                        <>
                          {r.quantity}
                          <div className="text-xs text-muted-foreground">{r.inUse} in use · {r.available} free</div>
                        </>
                      ) : "1"}
                    </TD>
                    <TD>
                      <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                      <div className="text-xs text-muted-foreground">{humanize(r.condition)}</div>
                    </TD>
                    <TD className="text-right text-sm whitespace-nowrap">{formatMoney(r.purchaseCost, r.currencyCode)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
