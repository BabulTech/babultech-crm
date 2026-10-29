import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { DeleteControl } from "@/components/delete-control";
import { RecentMark } from "@/components/recent-mark";
import { FavoriteControl } from "@/components/favorite-control";
import { FollowControl } from "@/components/follow-control";
import { notFound } from "next/navigation";
import { listNotes } from "@/server/notes";
import { listDocuments } from "@/server/documents";
import { NotesSection } from "@/components/notes-section";
import { DocumentsPanel } from "@/components/documents-panel";
import { getCase } from "@/server/cases";
import { getAuditTrail } from "@/lib/audit";
import { auditFieldLabel } from "@/lib/audit-format";
import { getCaseThread } from "@/server/case-thread";
import { CaseThread } from "./case-thread";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  StatTile, Button, Forbidden
} from "@/components/ui";
import { formatDateTime, formatDate, humanize } from "@/lib/utils";
import { FirstResponseControl } from "./case-controls";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const _me = await requireUser();
  if (!can(_me, PERMISSIONS.CASE_READ)) return <Forbidden what="support cases" />;

  const { id } = await params;

  const [notes, documents, thread, c, audit] = await Promise.all([
    listNotes("SupportCase", id),
    listDocuments("SupportCase", id),
    getCaseThread(id),
    getCase(id),
    getAuditTrail("Case", id, 15),
  ]);
  if (!c) notFound();
  const now = new Date();
  const responseLate = c.firstResponseDueAt && !c.firstRespondedAt && c.firstResponseDueAt < now;
  const resolutionLate = c.resolutionDueAt && !c.resolvedAt && c.resolutionDueAt < now;

  return (
    <>
      <PageHeader
        backTo="/cases"
        backLabel="Back to cases"
        title={c.subject} description={`${c.caseNumber} · ${humanize(c.caseType)}`}>
        <Badge tone={statusTone(c.priority)}>{humanize(c.priority)}</Badge>
        <Badge tone={statusTone(c.status)}>{humanize(c.status)}</Badge>
        <Button asChild variant="outline">
          <Link href={`/cases/${c.id}/edit`}>Edit</Link>
        </Button>
        <FollowControl entityType="SupportCase" entityId={id} />
        <CorrectControl type="SupportCase" id={id} />
        <FavoriteControl entityType="SupportCase" entityId={id} label={`${c.caseNumber ?? ""} ${c.subject ?? ""}`.trim()} />

        <RecentMark entityType="SupportCase" entityId={id} label={`${c.caseNumber ?? ""} ${c.subject ?? ""}`.trim()} />
        <DeleteControl type="SupportCase" id={id} name={`${c.caseNumber ?? ""} ${c.subject ?? ""}`.trim()} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="First response due"
          value={c.firstRespondedAt ? "Responded" : formatDateTime(c.firstResponseDueAt)}
          sublabel={c.firstRespondedAt ? formatDateTime(c.firstRespondedAt) : undefined}
          tone={c.firstRespondedAt ? "success" : responseLate ? "danger" : "neutral"}
        />
        <StatTile
          label="Resolution due"
          value={c.resolvedAt ? "Resolved" : formatDateTime(c.resolutionDueAt)}
          sublabel={c.resolvedAt ? formatDateTime(c.resolvedAt) : undefined}
          tone={c.resolvedAt ? "success" : resolutionLate ? "danger" : "neutral"}
        />
        <StatTile
          label="SLA"
          value={c.slaBreached ? "Breached" : "Within target"}
          sublabel={c.slaPolicy?.name}
          tone={c.slaBreached ? "danger" : "success"}
        />
        <StatTile
          label="Reopened"
          value={String(c.reopenCount)}
          sublabel={c.satisfactionScore ? `CSAT ${c.satisfactionScore}/5` : undefined}
          tone={c.reopenCount > 0 ? "warning" : "neutral"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>What was reported</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{c.description}</p>
            </CardContent>
          </Card>

          {(c.rootCause || c.resolution) && (
            <Card>
              <CardHeader>
                <CardTitle>Outcome</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {c.rootCause && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Root cause
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{c.rootCause}</p>
                  </div>
                )}
                {c.resolution && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Resolution
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{c.resolution}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Change history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {audit.length === 0 ? (
                <p className="text-muted-foreground">No changes recorded yet.</p>
              ) : (
                audit.map((a) => (
                  <div key={a.id}>
                    <p>
                      <span className="font-medium">{auditFieldLabel(a.fieldName)}</span>{" "}
                      <span className="text-muted-foreground">
                        {a.oldValue ?? "empty"} → {a.newValue ?? "empty"}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.changedBy?.fullName ?? "System"} · {formatDate(a.changedAt)}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <FirstResponseControl
            caseId={c.id}
            alreadyResponded={Boolean(c.firstRespondedAt)}
            dueAt={
              c.firstResponseDueAt
                ? new Date(c.firstResponseDueAt as string).toISOString()
                : null
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Customer">
                <Link href={`/accounts/${c.account?.id}`} className="text-primary hover:underline">
                  {c.account?.name}
                </Link>
                <p className="text-xs text-muted-foreground">{c.account?.accountNumber}</p>
              </Row>
              <Row label="Contact">
                {c.contact ? (
                  <>
                    <Link href={`/contacts/${c.contact?.id}/edit`} className="text-primary hover:underline">
                      {c.contact?.firstName} {c.contact?.lastName}
                    </Link>
                    {c.contact?.email && (
                      <p className="text-xs">
                        <a href={`mailto:${c.contact?.email}`} className="text-muted-foreground hover:underline">
                          {c.contact?.email}
                        </a>
                      </p>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Owner">{c.owner?.fullName ?? "Unassigned"}</Row>
              <Row label="Team">{c.team?.name ?? "—"}</Row>
              <Row label="Category">{c.category?.name ?? "Uncategorised"}</Row>
              <Row label="Came in via">{humanize(c.source)}</Row>
              <Row label="SLA policy">
                {c.slaPolicy
                  ? `${c.slaPolicy?.name} (${c.slaPolicy?.firstResponseMinutes}m / ${c.slaPolicy?.resolutionMinutes}m)`
                  : "None matched"}
              </Row>
              {c.project && (
                <Row label="Project">
                  <Link href={`/projects`} className="text-primary hover:underline">
                    {c.project?.projectNumber} - {c.project?.name}
                  </Link>
                </Row>
              )}
              {c.contract && (
                <Row label="Contract">
                  <Link href={`/contracts`} className="text-primary hover:underline">
                    {c.contract.contractNumber}
                  </Link>
                </Row>
              )}
              <Row label="Opened">{formatDateTime(c.createdAt)}</Row>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <CaseThread
          caseId={id}
          comments={thread.comments}
          events={thread.events}
          pausedMinutes={thread.pausedMinutes}
          currentStatus={c.status}
          canWrite={can(_me, PERMISSIONS.CASE_WRITE)}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="SupportCase" entityId={id} notes={notes} />
        <DocumentsPanel entityType="SupportCase" entityId={id} documents={documents} />
        <RecordEmail entityType="Case" entityId={id} />
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
