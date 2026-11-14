import { notFound } from "next/navigation";
import { getAsset, getInventoryOptions, updateAsset } from "@/server/inventory";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { AssetForm } from "../../asset-form";

export default async function EditAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ASSET_WRITE)) return <Forbidden what="editing the inventory" />;
  const { id } = await params;
  const [loaded, options] = await Promise.all([getAsset(id), getInventoryOptions()]);
  if (!loaded) notFound();
  const a = loaded.asset as Record<string, unknown>;
  const str = (k: string) => (a[k] == null ? null : String(a[k]));

  return (
    <>
      <PageHeader backTo={`/inventory/${id}`} backLabel="Back to the item" title={`Edit ${str("assetTag")}`} description={str("name") ?? ""} />
      <div className="max-w-3xl">
        <AssetForm
          action={updateAsset.bind(null, id)}
          options={options}
          editing
          costLocked={loaded.costLocked}
          defaults={{
            name: str("name"), typeId: str("typeId"), brand: str("brand"), model: str("model"), serialNumber: str("serialNumber"),
            locationId: str("locationId"), condition: str("condition"), warrantyEndsOn: str("warrantyEndsOn"),
            licenceExpiresOn: str("licenceExpiresOn"), notes: str("notes"), purchaseDate: str("purchaseDate"),
            purchaseCost: str("purchaseCost"), supplierName: str("supplierName"), supplierAccountId: str("supplierAccountId"),
            invoiceReference: str("invoiceReference"), purchaseDetails: str("purchaseDetails"),
          }}
          submitLabel="Save changes"
          redirectTo={`/inventory/${id}`}
        />
      </div>
    </>
  );
}
