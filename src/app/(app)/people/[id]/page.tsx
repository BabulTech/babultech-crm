import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { RowActions } from "@/components/row-actions";
import {
  PageHeader, Button, Card, CardHeader, CardTitle, CardContent, DetailRow, Badge, Table, THead, TBody, TR, TH, TD, Alert,
} from "@/components/ui";
import { DocumentsPanel } from "@/components/documents-panel";
import { listDocuments } from "@/server/documents";
import { getPerson, getReportingLine } from "@/server/people";
import { CONTRACT_TYPE_LABELS, CONTRACT_STATUS_LABELS, contractTone, payLabel, daysUntil, isCofounder, percentLabel, type ContractStatus, type ContractType } from "@/lib/people";
import { formatDate, humanize } from "@/lib/utils";
import { LoginPanel } from "./login-panel";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const [data, documents, reportingLine] = await Promise.all([
    getPerson(id),
    listDocuments("StaffProfile", id),
    getReportingLine(id),
  ]);
  if (!data) notFound();
  const { staff, contracts, canWrite, canCreateLogins } = data;
  const canDeleteContracts = can(me, PERMISSIONS.RECORD_DELETE);

  const running = contracts.find((c) => c.status === "ACTIVE");
  const pending = contracts.find((c) => ["DRAFT", "SENT", "EMPLOYEE_SIGNED", "SIGNED"].includes(c.status));
  const followed = new Set(contracts.map((c) => c.previousContractId).filter(Boolean));
  const renewable = contracts.find((c) => ["ACTIVE", "ENDED"].includes(c.status) && !followed.has(c.id));
  const left = running?.endDate ? daysUntil(running.endDate) : null;
  const revisable = renewable && isCofounder(renewable.contractType);
  const s = (k: string) => (staff[k] ? String(staff[k]) : "—");
  const link = (k: string, label: string) => staff[k]
    ? <a href={String(staff[k])} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{label}<ExternalLink className="h-3 w-3" /></a>
    : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={staff.fullName} description={`${staff.profileNumber} · ${humanize(staff.status)}`} backTo="/people" backLabel="People">
        {canWrite && <Button asChild variant="outline"><Link href={`/people/${id}/edit`}>Edit</Link></Button>}
        {canWrite && renewable && revisable && (
          <Button asChild><Link href={`/people/${id}/contracts/new?from=${renewable.id}&mode=renew`}>Revise agreement</Link></Button>
        )}
        {canWrite && renewable && !revisable && (
          <>
            <Button asChild variant="outline"><Link href={`/people/${id}/contracts/new?from=${renewable.id}&mode=renew`}>Renew contract</Link></Button>
            <Button asChild><Link href={`/people/${id}/contracts/new?from=${renewable.id}&mode=convert`}>Convert</Link></Button>
          </>
        )}
        {canWrite && !running && !pending && !renewable && (
          <Button asChild><Link href={`/people/${id}/contracts/new`}>New contract</Link></Button>
        )}
      </PageHeader>

      {running && running.endDate && left != null && left <= 30 && !followed.has(running.id) && (
        <div className="mb-6">
          <Alert tone={left <= 7 ? "danger" : "warning"}>
            {CONTRACT_TYPE_LABELS[running.contractType as ContractType]} contract {running.contractNumber} ends {left === 0 ? "today" : `in ${left} day${left === 1 ? "" : "s"}`}, on {formatDate(running.endDate)}.
            {canWrite ? " Renew it, convert it, or let it end and their login is switched off the day after." : ""}
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Contracts</CardTitle></CardHeader>
            {contracts.length === 0 ? (
              <CardContent className="text-sm text-muted-foreground">No contracts.</CardContent>
            ) : (
              <Table>
                <THead><TR><TH>Contract</TH><TH>Position</TH><TH>Term</TH><TH>Pay or equity</TH><TH>Status</TH>{canDeleteContracts && <TH><span className="sr-only">Actions</span></TH>}</TR></THead>
                <TBody>
                  {contracts.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <Link href={`/people/contracts/${c.id}`} className="font-medium hover:underline">{CONTRACT_TYPE_LABELS[c.contractType as ContractType]}</Link>
                        <p className="text-xs text-muted-foreground">{c.contractNumber}{c.previousContractId ? " · follows an earlier contract" : ""}</p>
                      </TD>
                      <TD className="text-sm">{c.jobTitle}</TD>
                      <TD className="text-sm">{formatDate(c.startDate)} – {c.endDate ? formatDate(c.endDate) : "no end date"}{c.lastWorkingDay && <p className="text-xs text-muted-foreground">Last day {formatDate(c.lastWorkingDay)}</p>}</TD>
                      <TD className="text-sm">{isCofounder(c.contractType) ? `${percentLabel(c.equityPercent)} equity` : payLabel(c.payBasis, c.payAmount, c.currencyCode)}</TD>
                      <TD><Badge tone={contractTone(c.status)}>{CONTRACT_STATUS_LABELS[c.status as ContractStatus]}</Badge></TD>
                      {canDeleteContracts && (
                        <TD className="text-right">
                          <RowActions type="EmploymentContract" id={c.id} name={c.contractNumber} canDelete />
                        </TD>
                      )}
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>Education</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {staff.education.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
              {staff.education.map((e, i) => (
                <div key={i}>
                  <p className="font-medium">{e.degree}{e.field ? `, ${e.field}` : ""}</p>
                  <p className="text-muted-foreground">{e.institution}{e.startYear || e.endYear ? ` · ${e.startYear ?? ""}–${e.endYear ?? ""}` : ""}{e.grade ? ` · ${e.grade}` : ""}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Experience</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {staff.experience.length === 0 && <p className="text-muted-foreground">None recorded.</p>}
              {staff.experience.map((e, i) => (
                <div key={i}>
                  <p className="font-medium">{e.title} · {e.company}</p>
                  <p className="text-muted-foreground">{e.startDate ?? ""}{e.startDate ? " – " : ""}{e.endDate || (e.startDate ? "now" : "")}</p>
                  {e.summary && <p className="mt-1 whitespace-pre-wrap">{e.summary}</p>}
                </div>
              ))}
              {staff.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-2">
                  {staff.skills.map((sk) => <Badge key={sk} tone="neutral">{sk}</Badge>)}
                </div>
              )}
            </CardContent>
          </Card>

          <DocumentsPanel entityType="StaffProfile" entityId={id} documents={documents} />
        </div>

        <div className="space-y-6">
          <LoginPanel staffId={id} user={staff.user} canCreateLogins={canCreateLogins} hasContract={contracts.some((c) => c.status !== "CANCELLED")} reportingLine={reportingLine} />

          <Card>
            <CardHeader><CardTitle>Personal</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Reports to">
                {reportingLine?.current ? `${reportingLine.current.fullName}${reportingLine.current.active ? "" : " (login switched off)"}` : "Nobody"}
              </DetailRow>
              <DetailRow label="Father's name">{s("fatherName")}</DetailRow>
              <DetailRow label="CNIC">{s("nationalId")}</DetailRow>
              <DetailRow label="Date of birth">{staff.dateOfBirth ? formatDate(String(staff.dateOfBirth)) : "—"}</DetailRow>
              <DetailRow label="Gender">{s("gender")}</DetailRow>
              <DetailRow label="Personal email">{s("personalEmail")}</DetailRow>
              <DetailRow label="Phone">{s("phone")}</DetailRow>
              <DetailRow label="Address">{[staff.address, staff.city, staff.country].filter(Boolean).join(", ") || "—"}</DetailRow>
              <DetailRow label="Emergency contact">
                {staff.emergencyContactName ? `${staff.emergencyContactName}${staff.emergencyContactRelation ? ` (${staff.emergencyContactRelation})` : ""} ${staff.emergencyContactPhone ?? ""}` : "—"}
              </DetailRow>
              <div className="flex flex-wrap gap-3 pt-1">
                {link("linkedinUrl", "LinkedIn")}{link("githubUrl", "GitHub")}{link("portfolioUrl", "Portfolio")}
              </div>
              {staff.notes ? <p className="whitespace-pre-wrap border-t pt-3 text-muted-foreground">{String(staff.notes)}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
