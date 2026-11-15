import Link from "next/link";
import { listOfferings } from "@/server/offerings";
import { listProposalsFor, listProposalTemplates } from "@/server/proposals";
import { getOnboardingForOpportunity, listPlaybooks } from "@/server/onboarding";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import { PROPOSAL_STATUS_LABELS } from "@/lib/proposals";
import { formatDate } from "@/lib/utils";
import { OfferingPicker, CreateProposal, StartOnboarding } from "./sales-process-controls";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral", SENT: "info", VIEWED: "info", CHANGES_REQUESTED: "warning", ACCEPTED: "success", DECLINED: "danger", SUPERSEDED: "neutral",
};

/** On a deal: what kind of sale it is, its proposals, and the customer's onboarding once won. */
export async function SalesProcessPanel({ opportunityId, offeringId, stage, canWrite }: { opportunityId: string; offeringId: string | null; stage: string; canWrite: boolean }) {
  const [offerings, proposals, templates, onboarding, playbooks] = await Promise.all([
    listOfferings(), listProposalsFor(opportunityId), listProposalTemplates(), getOnboardingForOpportunity(opportunityId), listPlaybooks(),
  ]);
  const closed = stage === "CLOSED_WON" || stage === "CLOSED_LOST";
  // Latest version of each proposal number only.
  const latest = proposals.filter((p, i) => proposals.findIndex((q) => q.proposalNumber === p.proposalNumber) === i);
  const offeringTemplates = templates.filter((t) => !t.offeringId || t.offeringId === offeringId);
  const defaultTemplate = templates.find((t) => t.offeringId && t.offeringId === offeringId)?.id ?? null;
  const usablePlaybooks = playbooks.filter((p) => p.active);
  const defaultPlaybook = usablePlaybooks.find((p) => p.offeringId === offeringId)?.id ?? null;

  return (
    <Card data-sales-process>
      <CardHeader><CardTitle>Proposal and onboarding</CardTitle></CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
          <span className="font-medium">Offering</span>
          <OfferingPicker opportunityId={opportunityId} value={offeringId} offerings={offerings} disabled={!canWrite} />
        </div>

        <div className="space-y-2">
          <div className="font-medium">Proposals</div>
          {latest.length === 0 && <p className="text-muted-foreground">No proposal yet.</p>}
          {latest.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
              <Link href={`/proposals/${p.id}`} className="hover:underline">
                <span className="font-mono text-xs">{p.proposalNumber}{p.version > 1 ? ` v${p.version}` : ""}</span> {p.title}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {p.sentAt && `sent ${formatDate(p.sentAt)}`}
                <Badge tone={TONE[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
              </span>
            </div>
          ))}
          {canWrite && !closed && <CreateProposal opportunityId={opportunityId} templates={offeringTemplates} defaultTemplateId={defaultTemplate} />}
        </div>

        <div className="space-y-2">
          <div className="font-medium">Onboarding</div>
          {onboarding ? (
            <Link href={`/onboarding/${onboarding.id}`} className="flex items-center justify-between rounded-md border p-2 hover:bg-muted/40" data-deal-onboarding>
              <span>{onboarding.onboardingNumber} · {onboarding.summary.done} of {onboarding.summary.total} steps{onboarding.summary.overdue ? ` · ${onboarding.summary.overdue} overdue` : ""}</span>
              <Badge tone={onboarding.status === "LIVE" ? "success" : onboarding.status === "CANCELLED" ? "neutral" : "info"}>{onboarding.status === "LIVE" ? "Live" : onboarding.status === "CANCELLED" ? "Cancelled" : "In progress"}</Badge>
            </Link>
          ) : stage === "CLOSED_WON" ? (
            canWrite ? <StartOnboarding opportunityId={opportunityId} playbooks={usablePlaybooks} defaultPlaybookId={defaultPlaybook} /> : <p className="text-muted-foreground">Not started.</p>
          ) : (
            <p className="text-muted-foreground">Starts automatically when the deal is marked Closed won{offeringId ? (defaultPlaybook ? ", from the offering's playbook" : " - this offering has no playbook yet") : " - set the offering above so the right playbook is used"}.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
