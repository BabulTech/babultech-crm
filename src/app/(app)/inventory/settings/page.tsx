import { getInventoryOptions } from "@/server/inventory";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Forbidden, Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { AddTypeForm, AddNamedForm, ToggleActive } from "./settings-forms";

export default async function InventorySettingsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ASSET_WRITE)) return <Forbidden what="inventory settings" />;
  const options = await getInventoryOptions();

  return (
    <>
      <PageHeader backTo="/inventory" backLabel="Back to inventory" title="Inventory types and places" description="The Type dropdown, its categories, and the places items can be kept or given to." />

      <Card>
        <CardHeader><CardTitle>Item types</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <AddTypeForm categories={options.categories.filter((c) => c.active)} />
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Type</TH><TH>Category</TH><TH>Tracked</TH><TH>Useful life</TH><TH /></TR></THead>
              <TBody>
                {options.types.map((t) => (
                  <TR key={t.id} className={t.active ? "" : "opacity-50"}>
                    <TD>{t.name} {!t.active && <Badge>Hidden</Badge>}</TD>
                    <TD>{t.categoryName}</TD>
                    <TD>{t.tracking === "QUANTITY" ? "Counted" : "One by one"}</TD>
                    <TD>{t.usefulLifeMonths ? `${t.usefulLifeMonths} months` : "—"}</TD>
                    <TD className="text-right"><ToggleActive kind="type" id={t.id} active={t.active} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Places</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <AddNamedForm kind="location" />
            <ul className="divide-y text-sm">
              {options.locations.map((l) => (
                <li key={l.id} className={`flex items-center justify-between py-2 ${l.active ? "" : "opacity-50"}`}>
                  <span>{l.name}</span>
                  <ToggleActive kind="location" id={l.id} active={l.active} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Categories</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <AddNamedForm kind="category" />
            <ul className="divide-y text-sm">
              {options.categories.map((c) => <li key={c.id} className="py-2">{c.name}</li>)}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
