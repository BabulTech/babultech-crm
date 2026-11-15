import Link from "next/link";
import { notFound } from "next/navigation";
import { getProposal } from "@/server/proposals";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, Forbidden, Alert } from "@/components/ui";
import { ProposalDocument } from "@/components/proposal-document";
import { PROPOSAL_STATUS_LABELS, proposalDate, type ProposalSection } from "@/lib/proposals";
import { formatDateTime, formatMoney, humanize } from "@/lib/utils";
import { ProposalEditor, SendPanel, NewVersionButton } from "./proposal-editor";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral", SENT: "info", VIEWED: "info", CHANGES_REQUESTED: "warning", ACCEPTED: "success", DECLINED: "danger", SUPERSEDED: "neutral",
};

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.OPPORTUNITY_READ)) return <Forbidden what="proposals" />;
  const { id } = await params;
  const p = await getProposal(id);
  if (!p) notFound();
  const draft = p.status === "DRAFT";
  const sections = p.sections as ProposalSection[];
  const latest = Math.max(...p.versions.map((v) => v.version));

  return (
    <>
      <PageHeader
        backTo={`/opportunities/${p.opportunity.id}`}
        backLabel={`Back to ${p.opportunity.name}`}
        title={`${p.proposalNumber}${p.version > 1 ? ` v${p.version}` : ""}`}
        description={p.title}
      >
        <Badge tone={TONE[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
        {!draft && p.canWrite && p.version === latest && p.status !== "ACCEPTED" && <NewVersionButton id={p.id} />}
      </PageHeader>

      {p.versions.length > 1 && (
        <p className="mb-4 text-sm text-muted-foreground">
          Versions: {p.versions.map((v, i) => (
            <span key={v.id}>{i ? " · " : ""}{v.id === p.id ? <strong>v{v.version}</strong> : <Link className="text-primary hover:underline" href={`/proposals/${v.id}`}>v{v.version}</Link>} ({PROPOSAL_STATUS_LABELS[v.status].toLowerCase()})</span>
          ))}
        </p>
      )}

      {p.status === "ACCEPTED" && (
        <div className="mb-5">
          <Alert tone="success">
            <div className="space-y-2">
              <p><strong>Accepted by {p.acceptedName}</strong> on {formatDateTime(p.acceptedAt)}{p.acceptedIp ? ` from ${p.acceptedIp}` : ""}.</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.acceptedSignature && <img src={p.acceptedSignature} alt="Customer signature" className="h-16 rounded border bg-white" />}
              <p>Next: open the deal, accept the quotation and mark it Closed won. Onboarding starts automatically.</p>
            </div>
          </Alert>
        </div>
      )}
      {p.status === "CHANGES_REQUESTED" && (
        <div className="mb-5"><Alert tone="warning"><strong>The customer asked for changes:</strong> {p.customerComment}. Make a new version, edit it and send it.</Alert></div>
      )}
      {p.status === "DECLINED" && (
        <div className="mb-5"><Alert tone="danger"><strong>Declined.</strong> {p.customerComment}</Alert></div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {draft && p.canWrite ? (
            <ProposalEditor
              id={p.id} title={p.title} validUntil={p.validUntil} quotationId={p.quotationId}
              sections={sections.map((s) => (s.kind === "TEXT" ? { kind: "TEXT" as const, title: s.title, body: s.body } : { kind: "PRICING" as const, title: s.title }))}
              quotations={p.quotations.map((q) => ({ id: q.id, label: `${q.quoteNumber} v${q.versionNumber} · ${formatMoney(q.totalAmount, q.currencyCode)} · ${humanize(q.status)}${q.approvalStatus === "PENDING" ? " (awaiting approval)" : ""}` }))}
            />
          ) : null}
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{draft ? "Preview (as saved)" : "What the customer received"}</h2>
            <ProposalDocument
              companyName={p.companyName} title={p.title} number={p.proposalNumber} version={p.version}
              accountName={p.opportunity.account?.name ?? ""} date={(p.sentAt ?? p.createdAt)?.slice(0, 10)} validUntil={p.validUntil} sections={sections}
            />
          </div>
        </div>

        <div className="space-y-6">
          {draft && p.canWrite && (
            <Card>
              <CardHeader><CardTitle>Send to the customer</CardTitle></CardHeader>
              <CardContent>
                <SendPanel id={p.id} contacts={p.contacts.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, email: c.email }))} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!draft && <p className="text-muted-foreground">Sent {formatDateTime(p.sentAt)} to {p.sentTo}. {p.firstViewedAt ? `First opened ${formatDateTime(p.firstViewedAt)}.` : "Not opened yet."} Valid until {proposalDate(p.validUntil)}.</p>}
              <ul className="space-y-2">
                {p.events.map((e) => (
                  <li key={e.id} className="border-l-2 pl-3">
                    <span className="font-medium">{humanize(e.kind)}</span>{e.note ? ` · ${e.note}` : ""}
                    <div className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)} · {e.actor?.fullName ?? "Customer"}</div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
