import { createAsset, getInventoryOptions } from "@/server/inventory";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { AssetForm } from "../asset-form";

export default async function NewAssetPage({
  searchParams,
}: {
  searchParams: Promise<{ expenseId?: string; billId?: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ASSET_WRITE)) return <Forbidden what="adding to the inventory" />;

  const params = await searchParams;
  const options = await getInventoryOptions();
  // Arriving from an expense or bill ("Register as assets") links it and goes back there.
  const expenseId = params.expenseId && options.expenses.some((e) => e.id === params.expenseId) ? params.expenseId : null;
  const billId = params.billId && options.bills.some((b) => b.id === params.billId) ? params.billId : null;

  return (
    <>
      <PageHeader
        backTo={expenseId ? `/expenses/${expenseId}` : billId ? `/vendor-bills/${billId}` : "/inventory"}
        backLabel={expenseId ? "Back to the expense" : billId ? "Back to the bill" : "Back to inventory"}
        title="Add to inventory"
        description="Something the company owns: what it is, where it lives, and what paid for it."
      />
      <div className="max-w-3xl">
        <AssetForm
          action={createAsset}
          options={options}
          defaults={{ paidHow: expenseId ? "EXPENSE" : billId ? "BILL" : undefined, expenseId, vendorBillId: billId }}
          submitLabel="Add to inventory"
          redirectTo={expenseId ? `/expenses/${expenseId}` : billId ? `/vendor-bills/${billId}` : "/inventory"}
        />
      </div>
    </>
  );
}
