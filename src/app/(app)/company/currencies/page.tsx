import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getCompanyInformation } from "@/server/company";
import { PageHeader, Forbidden } from "@/components/ui";
import { CurrencyEditor } from "./currency-editor";

export default async function CurrenciesPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="currencies" />;

  const { currencies, setting } = await getCompanyInformation();

  return (
    <>
      <PageHeader
        backTo="/overview?tab=profile"
        backLabel="Back to Company overview"
        title="Currencies"
        description="Add a currency, or set its exchange rate against PKR. Every conversion in the system goes through these rates."
      />
      <CurrencyEditor
        currencies={currencies}
        defaultCurrency={setting?.defaultCurrency ?? "PKR"}
        corporateCurrency={setting?.corporateCurrency ?? "USD"}
      />
    </>
  );
}
