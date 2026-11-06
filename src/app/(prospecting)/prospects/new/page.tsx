import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { listDatasets } from "@/server/prospects";
import { NewProspectForm } from "./new-prospect-form";

export default async function NewProspectPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="adding prospects" />;
  const datasets = await listDatasets();
  return (
    <>
      <PageHeader
        backTo="/prospects"
        backLabel="Prospects"
        title="New prospect"
        description="One business, typed in. To add many at once, use Import."
      />
      <NewProspectForm datasets={datasets.map((d) => ({ id: d.id, name: d.name }))} partner={Boolean(me.partnerId)} />
    </>
  );
}
