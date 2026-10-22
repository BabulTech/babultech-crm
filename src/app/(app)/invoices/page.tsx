import Link from "next/link";
import { SavedViewsControl } from "@/components/saved-views";
import { applyDefaultView } from "@/server/saved-views";
import { Plus } from "lucide-react";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import { applySearch, LIST_LIMIT } from "@/lib/db";
import { ListFilters, optionsFrom } from "@/components/list-filters";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { RowActions } from "@/components/row-actions";
import { RECYCLE_TYPES } from "@/lib/recycle-types";
import { ExportButton } from "@/components/export-button";
import {
  PageHeader, Card, Table, THead, TBody, TR, TH, TD, Badge, statusTone,
  EmptyState, StatTile, Alert, Button, Forbidden
} from "@/components/ui";
import { BillingRun } from "./billing-run";
import { formatMoney, formatDate, humanize, daysBetween, formatMoneyTotal } from "@/lib/utils";

/** Receivables: what has been billed, what is overdue, and what to bill next. */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; status?: string }>;
}) {
  const _me = await requireUser();
  const canDeleteRow = can(_me, RECYCLE_TYPES.Invoice.permission);
  if (!can(_me, PERMISSIONS.INVOICE_READ)) return <Forbidden what="invoices" />;

  const params = await searchParams;
  await applyDefaultView("invoices", params);
  const db = await supabaseServer();

  let query = db
    .from("invoice")
    .select(
      `*,
       account ( id, name ),
       project ( id, name ),
       allocations:payment_allocation ( count )`,
    )
    .is("deletedAt", null)
    .order("dueDate");

  if (params.status) query = query.eq("status", params.status);
  query = applySearch(query, params.search, ["invoiceNumber"]);

  // The billing run's project list needs nothing from the invoices, so both
  // reads go together. Projects it can act on: anything live with work to bill.
  const [{ data: invoiceRows }, { data: billableProjectRows }] = await Promise.all([
    query.limit(LIST_LIMIT),
    db
      .from("project")
      .select("id, name, projectNumber")
      .is("deletedAt", null)
      .in("status", ["PLANNING", "ACTIVE", "AT_RISK", "COMPLETED"])
      .order("name"),
  ]);

  const invoices = (invoiceRows ?? []).map((i) => ({
    ...i,
    account: one(i.account as never),
    project: one(i.project as never),
    _count: {
      allocations: (i.allocations as { count: number }[] | undefined)?.[0]?.count ?? 0,
    },
  }));

  const billableProjects = billableProjectRows ?? [];

  const now = new Date();
  const live = invoices.filter((i) => !["DRAFT", "CANCELLED", "PAID", "WRITTEN_OFF"].includes(i.status));
  // dueDate arrives as an ISO string, not a Date. `string < Date` is always
  // false, so without parsing the overdue tile would silently read zero.
  const overdue = live.filter((i) => new Date(i.dueDate as string) < now);
  const outstanding = live.reduce((s, i) => s + Number(i.outstandingAmount), 0);
  const overdueTotal = overdue.reduce((s, i) => s + Number(i.outstandingAmount), 0);

  return (
    <>
      <PageHeader title="Invoices" description="Customer billing and what is still owed to you.">
        <ExportButton entity="invoices" params={{ search: params.search, status: params.status }} />
        <Button asChild variant="outline">
          <Link href="/payments">Payments</Link>
        </Button>
        <BillingRun projects={billableProjects} />
        <Button asChild>
          <Link href="/invoices/new">
            <Plus className="h-4 w-4" /> New invoice
          </Link>
        </Button>
        <SavedViewsControl entity="invoices" />
      </PageHeader>

      <div className="mb-6">
        <Alert tone="info">
          Phase 4 module. Invoicing, payment allocation, expenses and vendor bills are modelled and
          the AR/AP views are written - this page reads them; the billing workflow comes next.
        </Alert>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Outstanding" value={formatMoneyTotal(outstanding)} sublabel={`${live.length} open invoices`} />
        <StatTile label="Overdue" value={formatMoneyTotal(overdueTotal)} sublabel={`${overdue.length} invoices`} tone={overdue.length ? "danger" : "success"} />
        <StatTile
          label="Collected"
          value={formatMoneyTotal(invoices.reduce((s, i) => s + Number(i.paidAmount), 0))}
          tone="success"
        />
        <StatTile label="Total invoices" value={String(invoices.length)} />
      </div>

      <div className="mt-6">
        <ListFilters
          searchPlaceholder="Search invoice number…"
          searchValue={params.search}
          selects={[
            {
              name: "status",
              allLabel: "All statuses",
              value: params.status,
              options: optionsFrom([
                "DRAFT", "APPROVED", "SENT", "PARTIALLY_PAID",
                "PAID", "OVERDUE", "CANCELLED", "WRITTEN_OFF",
              ]),
            },
          ]}
        />
      </div>

      <Card>
        {invoices.length === 0 ? (
          <EmptyState title="No invoices match" description="Invoices are raised from a contract, a billing milestone, or approved time." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Invoice</TH>
                <TH priority="secondary">Customer</TH>
                <TH priority="tertiary">Issued</TH>
                <TH priority="secondary">Due</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right" priority="tertiary">Paid</TH>
                <TH className="text-right">Outstanding</TH>
                <TH priority="tertiary">Ageing</TH>
                <TH>Status</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <TBody>
              {invoices.map((i) => {
                const days = daysBetween(i.dueDate, now);
                const late = days > 0 && Number(i.outstandingAmount) > 0;
                const bucket = !late ? "Current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";

                return (
                  <TR key={i.id}>
                    <TD className="font-mono text-xs">
                      <Link href={`/invoices/${i.id}`} className="hover:underline">{i.invoiceNumber}</Link>
                    </TD>
                    <TD priority="secondary" className="text-sm">
                      <Link href={`/accounts/${i.account?.id}`} className="hover:underline">
                        {i.account?.name}
                      </Link>
                      {i.project && (
                        <Link href={`/projects/${i.project?.id}`} className="block text-xs text-muted-foreground hover:underline">
                          {i.project?.name}
                        </Link>
                      )}
                    </TD>
                    <TD priority="tertiary" className="text-sm">{formatDate(i.invoiceDate)}</TD>
                    <TD priority="secondary" className={`text-sm ${late ? "text-red-600 dark:text-red-400" : ""}`}>
                      {formatDate(i.dueDate)}
                    </TD>
                    <TD className="text-right tabular">{formatMoney(i.totalAmount, i.currencyCode)}</TD>
                    <TD priority="tertiary" className="text-right tabular text-muted-foreground">
                      {formatMoney(i.paidAmount, i.currencyCode)}
                    </TD>
                    <TD className="text-right font-medium tabular">
                      {formatMoney(i.outstandingAmount, i.currencyCode)}
                    </TD>
                    <TD priority="tertiary">
                      <Badge tone={late ? "danger" : "neutral"}>{bucket}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(i.status)}>{humanize(i.status)}</Badge>
                    </TD>
                    <TD className="text-right">
                      <RowActions type="Invoice" id={i.id} name={String(i.invoiceNumber ?? "")} editHref={`/invoices/${i.id}/edit`} canDelete={canDeleteRow} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
