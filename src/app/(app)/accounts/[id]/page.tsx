import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { Timeline } from "@/components/timeline";
import { DeleteControl } from "@/components/delete-control";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { FollowControl } from "@/components/follow-control";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { ActivitiesPanel } from "@/components/activities-panel";
import { listActivitiesFor } from "@/server/activities";
import { AuditPanel } from "@/components/audit-panel";
import { getAuditTrail } from "@/lib/audit";
import { DocumentsPanel } from "@/components/documents-panel";
import { getAccount } from "@/server/crm";
import { getAccountRelationship } from "@/server/relationship";
import { AccountRelationshipSections } from "@/components/relationship-sections";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Table, THead, TBody, TR, TH, TD, StatTile, Button, Alert, Forbidden
} from "@/components/ui";
import { formatMoney, formatDate, humanize, formatMoneyTotal } from "@/lib/utils";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.ACCOUNT_READ)) return <Forbidden what="accounts" />;

  const { id } = await params;

  const [notes, documents, audit, activities, relationship] = await Promise.all([
    listNotes("Account", id),
    listDocuments("Account", id),
    getAuditTrail("Account", id, 15),
    listActivitiesFor("Account", id),
    getAccountRelationship(id),
  ]);
  const account = await getAccount(id);
  if (!account) notFound();

  const openPipeline = account.opportunities
    .filter((o: Record<string, any>) => !["CLOSED_WON", "CLOSED_LOST"].includes(o.stage as string))
    .reduce((s: number, o: Record<string, any>) => s + Number(o.amount), 0);
  const outstanding = account.invoices.reduce((s: number, i: Record<string, any>) => s + Number(i.outstandingAmount), 0);

  return (
    <>
      <PageHeader
        backTo="/accounts"
        backLabel="Back to accounts"
        title={account.name} description={`${account.accountNumber} · ${humanize(account.accountType)}`}>
        {account.customerHealth && (
          <Badge tone={statusTone(account.customerHealth)}>{humanize(account.customerHealth)}</Badge>
        )}
        <Button asChild variant="outline">
          <Link href={`/contacts/new?accountId=${account.id}`}>Add contact</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/opportunities/new?accountId=${account.id}`}>New deal</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/cases/new?accountId=${account.id}`}>New case</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/projects/new?accountId=${account.id}`}>New project</Link>
        </Button>
        <Button asChild>
          <Link href={`/accounts/${account.id}/edit`}>Edit</Link>
        </Button>
        <FollowControl entityType="Account" entityId={id} />
        <FavoriteControl entityType="Account" entityId={id} label={String(account.name ?? "")} />
        <RecentMark entityType="Account" entityId={id} label={String(account.name ?? "")} />
        <DeleteControl type="Account" id={id} name={String(account.name ?? "")} />
      </PageHeader>

      {account.sourcePartner && (
        <div className="mb-5">
          <Alert tone="info">
            Brought to us by{" "}
            <Link href={`/partners/${account.sourcePartner.id}`} className="font-medium underline">
              {account.sourcePartner.displayName}
            </Link>
            . Deals on this account are credited to them, and earn them commission at their rate.
          </Alert>
        </div>
      )}

      {account.partner && (
        <div className="mb-5">
          <Alert tone="info">
            This account is also a <strong>{humanize(account.partner?.partnerType)}</strong> partner
            ({humanize(account.partner?.tier)} tier).{" "}
            <Link href={`/partners/${account.partner?.id}`} className="underline">
              Open the partner record
            </Link>{" "}
            to see sourced deals and commission.
          </Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Open pipeline" value={formatMoneyTotal(openPipeline)} sublabel={`${account.opportunities.length} deals`} />
        <StatTile label="Outstanding" value={formatMoneyTotal(outstanding)} sublabel={`${account.invoices.length} open invoices`} tone={outstanding > 0 ? "warning" : "neutral"} />
        <StatTile label="Open cases" value={String(account.cases.filter((c: Record<string, any>) => !["CLOSED", "CANCELLED"].includes(c.status as string)).length)} href="/cases" />
        <StatTile label="Projects" value={String(account.projects.length)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Company</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Owner">{account.owner?.fullName}</Row>
            <Row label="Industry">{account.industry ?? "—"}</Row>
            <Row label="Website">
              {account.website ? (
                <a href={account.website} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  {account.website}
                </a>
              ) : "—"}
            </Row>
            <Row label="Phone">{account.mainPhone ?? "—"}</Row>
            <Row label="Tax / NTN">{account.taxNumberNtn ?? "—"}</Row>
            <Row label="Credit limit">{account.creditLimit ? formatMoney(account.creditLimit) : "—"}</Row>
            <Row label="Payment terms">
              {account.paymentTermsDays ? `${account.paymentTermsDays} days` : "—"}
            </Row>
            {account.parentAccount && (
              <Row label="Parent">
                <Link href={`/accounts/${account.parentAccount?.id}`} className="text-primary hover:underline">
                  {account.parentAccount?.name}
                </Link>
              </Row>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Contacts ({account.contacts.length})</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {account.contacts.length === 0 ? (
              <p className="px-5 pb-2 text-sm text-muted-foreground">No contacts yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH priority="tertiary">Title</TH>
                    {/* Email is how you actually contact someone, so it
                        outranks the job title on a phone. */}
                    <TH priority="secondary">Email</TH>
                    <TH priority="tertiary">Phone</TH>
                    <TH priority="tertiary">Role</TH>
                  </TR>
                </THead>
                <TBody>
                  {account.contacts.map((c: Record<string, any>) => (
                    <TR key={c.id}>
                      <TD className="text-sm font-medium">
                        <Link href={`/contacts/${c.id}/edit`} className="hover:underline">
                          {c.firstName} {c.lastName}
                        </Link>
                        {c.isPrimary && <Badge tone="info" className="ml-2">Primary</Badge>}
                        {/* The dropped columns still matter on a phone, so the
                            most useful one rides along under the name rather
                            than vanishing entirely. */}
                        {c.email && (
                          <a
                            href={`mailto:${c.email}`}
                            className="mt-0.5 block truncate text-xs font-normal text-primary sm:hidden"
                          >
                            {c.email}
                          </a>
                        )}
                      </TD>
                      <TD priority="tertiary" className="text-sm text-muted-foreground">{c.jobTitle ?? "—"}</TD>
                      <TD priority="secondary" className="text-sm">
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="text-primary hover:underline">{c.email}</a>
                        ) : "—"}
                      </TD>
                      <TD priority="tertiary" className="text-sm text-muted-foreground">{c.mobile ?? c.phone ?? "—"}</TD>
                      <TD priority="tertiary" className="text-sm text-muted-foreground">{c.contactRole ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Opportunities</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {account.opportunities.length === 0 ? (
            <p className="px-5 pb-2 text-sm text-muted-foreground">No deals recorded.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Deal</TH>
                  <TH className="text-right">Amount</TH>
                  <TH priority="tertiary">Expected close</TH>
                  <TH priority="secondary">Stage</TH>
                </TR>
              </THead>
              <TBody>
                {account.opportunities.map((o: Record<string, any>) => (
                  <TR key={o.id}>
                    <TD>
                      <Link href={`/opportunities/${o.id}`} className="text-sm font-medium hover:underline">
                        {o.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{o.opportunityNumber}</p>
                      {/* Stage is what makes a deal row meaningful; on a phone
                          it sits under the name rather than dropping out. */}
                      <div className="mt-1 sm:hidden">
                        <Badge tone={statusTone(o.stage)}>{humanize(o.stage)}</Badge>
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap text-right tabular">{formatMoney(o.amount, o.currencyCode)}</TD>
                    <TD priority="tertiary" className="text-sm">{formatDate(o.expectedCloseDate)}</TD>
                    <TD priority="secondary">
                      <Badge tone={statusTone(o.stage)}>{humanize(o.stage)}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent cases</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {account.cases.length === 0 ? (
              <p className="px-5 pb-2 text-sm text-muted-foreground">No support cases.</p>
            ) : (
              <ul className="divide-y">
                {account.cases.map((c: Record<string, any>) => (
                  <li key={c.id} className="flex items-center justify-between px-5 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/cases/${c.id}`} className="truncate text-sm font-medium hover:underline">
                        {c.subject}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {c.caseNumber} · {formatDate(c.createdAt)}
                      </p>
                    </div>
                    <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open invoices</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {account.invoices.length === 0 ? (
              <p className="px-5 pb-2 text-sm text-muted-foreground">Nothing outstanding.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Invoice</TH>
                    <TH priority="secondary">Due</TH>
                    <TH className="text-right">Outstanding</TH>
                    <TH priority="secondary">Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {account.invoices.map((i: Record<string, any>) => (
                    <TR key={i.id}>
                      <TD className="font-mono text-xs">
                        <Link href={`/invoices/${i.id}`} className="hover:underline">{i.invoiceNumber}</Link>
                        {/* An unpaid invoice with no due date on screen cannot
                            be triaged, so both ride along under the number. */}
                        <div className="mt-1 flex items-center gap-2 sm:hidden">
                          <Badge tone={statusTone(i.status)}>{humanize(i.status)}</Badge>
                          <span className="font-sans text-muted-foreground">{formatDate(i.dueDate)}</span>
                        </div>
                      </TD>
                      <TD priority="secondary" className="text-sm">{formatDate(i.dueDate)}</TD>
                      <TD className="whitespace-nowrap text-right tabular">{formatMoney(i.outstandingAmount, i.currencyCode)}</TD>
                      <TD priority="secondary">
                        <Badge tone={statusTone(i.status)}>{humanize(i.status)}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AccountRelationshipSections data={relationship} />

      <div className="mt-6">
        <ActivitiesPanel
          entityType="Account"
          entityId={id}
          activities={activities}
          canWrite={can(_me, PERMISSIONS.LEAD_WRITE)}
        />
      </div>
      <Timeline entityType="Account" id={id} className="mt-6" />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Account" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Account" entityId={id} documents={documents} />
        <RecordEmail entityType="Account" entityId={id} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
