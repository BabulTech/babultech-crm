import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { listDatasets } from "@/server/prospects";
import { ProspectImporter } from "./prospect-importer";

export default async function ImportProspectsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="importing prospects" />;
  const datasets = await listDatasets();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Import prospects"
        description="An Excel or CSV file of businesses, of any size. Choose what each column is; anything else is kept on the prospect as an extra field."
        backTo="/prospects"
        backLabel="Prospects"
      />
      <ProspectImporter datasets={datasets.map((d) => ({ id: d.id, name: d.name }))} />
    </div>
  );
}
