import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { InventoryImporter } from "./inventory-importer";

export default async function InventoryImportPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ASSET_WRITE)) return <Forbidden what="importing inventory" />;
  return (
    <>
      <PageHeader
        backTo="/inventory"
        backLabel="Back to inventory"
        title="Import inventory"
        description="Bring in everything the company already owns from the Excel template."
      />
      <div className="max-w-5xl"><InventoryImporter /></div>
    </>
  );
}
