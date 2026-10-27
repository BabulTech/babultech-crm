import Link from "next/link";
import { Upload } from "lucide-react";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, Table, THead, TBody, TR, TH, TD, Button, Forbidden, EmptyState } from "@/components/ui";
import { formatDate, formatNumber } from "@/lib/utils";
import { listDatasets } from "@/server/prospects";
import { DatasetActions, NewDataset } from "./dataset-actions";

export default async function DatasetsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) return <Forbidden what="prospects" />;
  const canWrite = can(me, PERMISSIONS.PROSPECT_WRITE);
  const datasets = await listDatasets();

  return (
    <>
      <PageHeader title="Datasets" description="Each list of prospects you have imported, and how much of it has been worked." backTo="/prospects" backLabel="Prospects">
        {canWrite && <NewDataset />}
        {canWrite && <Button asChild><Link href="/prospects/import"><Upload className="h-4 w-4" /> Import</Link></Button>}
      </PageHeader>
      <Card>
        {datasets.length === 0 ? (
          <EmptyState title="No datasets yet" description="Import a spreadsheet of businesses to create the first one." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Dataset</TH>
                <TH>Prospects</TH>
                <TH>Being worked</TH>
                <TH>Qualified</TH>
                <TH priority="secondary">Added</TH>
                {canWrite && <TH />}
              </TR>
            </THead>
            <TBody>
              {datasets.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <Link href={`/prospects?datasetId=${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                    {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
                  </TD>
                  <TD className="tabular-nums">{formatNumber(d.total, 0)}</TD>
                  <TD className="tabular-nums">{formatNumber(d.active, 0)}</TD>
                  <TD className="tabular-nums">{formatNumber(d.qualified, 0)}</TD>
                  <TD priority="secondary" className="text-sm text-muted-foreground">{formatDate(d.createdAt)}{d.createdBy ? ` · ${d.createdBy}` : ""}</TD>
                  {canWrite && <TD><DatasetActions dataset={{ id: d.id, name: d.name, description: d.description, total: d.total }} /></TD>}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
