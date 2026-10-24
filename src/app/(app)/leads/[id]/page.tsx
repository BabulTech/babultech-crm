import Link from "next/link";
import { CorrectControl } from "@/components/correction-gate";
import { Timeline } from "@/components/timeline";
import { MarketingPanel } from "@/components/marketing-panel";
import { QualifyProspectButton } from "@/components/qualify-prospect-button";
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
import { Mail, Phone, MessageCircle, ArrowRight } from "lucide-react";
import { getLead } from "@/server/crm";
import { getHandoffRecipients, getHandoffs } from "@/server/lead-handoffs";
import { RequestHandoffForm } from "../handoffs/forms";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone,
  Button, DetailRow, Alert, Forbidden, StatTile,
} from "@/components/ui";
import { formatMoney, formatDate, formatDateTime, humanize } from "@/lib/utils";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `campaign` is set when arriving from a campaign's lead list. */
  searchParams: Promise<{ campaign?: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.LEAD_READ)) return <Forbidden what="leads" />;

  const [{ id }, query] = await Promise.all([params, searchParams]);

  // getLead joins the group rather than following it: it takes only `id`, so
   // waiting for the other three to finish first bought nothing but a second
   // round trip. See the note on the project page for the latency arithmetic.
  const [notes, documents, audit, activities, lead] = await Promise.all([
    listNotes("Lead", id),
    listDocuments("Lead", id),
    getAuditTrail("Lead", id, 15),
    listActivitiesFor("Lead", id),
    getLead(id),
  ]);
  if (!lead) notFound();

  const name = `${lead.firstName} ${lead.lastName}`;
  const converted = Boolean(lead.convertedAt);
  const disqualified = lead.status === "DISQUALIFIED";
  const canHandoff = lead.ownerUserId === me.id && can(me, PERMISSIONS.LEAD_WRITE) && !converted && !disqualified;
  const handoffData = canHandoff ? await getHandoffs(1, id) : null;
  const pendingHandoff = handoffData?.handoffs.some(h => h.status === "PENDING");
  const recipients = canHandoff && !pendingHandoff ? await getHandoffRecipients() : [];

  /**
   * Which campaign a touch logged from here should be attributed to.
   *
   * The `campaign` query parameter wins because it says which campaign the
   * user was actually working in — a lead can be attributed to one campaign
   * while being worked as part of another. Its own campaign is the fallback so
   * the field is still prefilled when the lead is reached directly.
   */
  const attributedCampaignId = query.campaign ?? lead.campaign?.id ?? "";

  const logTouchHref = `/activities/new?${new URLSearchParams({
    relatedEntityType: "Lead",
    relatedEntityId: lead.id,
    activityType: "MESSAGE_SENT",
    subject: `Outreach to ${name}`,
    ...(attributedCampaignId ? { campaignId: String(attributedCampaignId) } : {}),
  })}`;

  return (
    <>
      <PageHeader
        backTo="/leads"
        backLabel="Back to leads"
        title={name} description={lead.companyName ?? lead.leadNumber}>
        {/* A plain title rather than a FieldHelp button: a badge has no room
            for a marker beside it, and these two are labels rather than fields
            someone fills in. */}
        <Badge
          tone={statusTone(lead.status)}
          title="How far along this lead is: New, then Contacted, Qualified, Unqualified or Converted. Converting is what creates the account, contact and deal."
        >
          {humanize(lead.status)}
        </Badge>
        {lead.rating && (
          <Badge
            tone={statusTone(lead.rating)}
            title="How warm they are - your judgement, not a calculation. Hot means ready to buy, Cold means keep in touch. Used to decide who to call first."
          >
            {humanize(lead.rating)}
          </Badge>
        )}
        {!converted && (
          <Button asChild variant="outline">
            <Link href={logTouchHref}>Log a touch</Link>
          </Button>
        )}
        {can(me, PERMISSIONS.LEAD_WRITE) && !converted && (
          <Button asChild variant="outline">
            <Link href={`/leads/${lead.id}/edit`}>Edit</Link>
          </Button>
        )}
        {can(me, PERMISSIONS.LEAD_WRITE) && !converted && !disqualified && !pendingHandoff && <Button asChild><Link href={`/leads/${lead.id}/convert`}>Convert lead</Link></Button>}
        {lead.status === "PROSPECT" && can(me, PERMISSIONS.LEAD_WRITE) && <QualifyProspectButton leadId={lead.id} />}
        {can(me, PERMISSIONS.LEAD_WRITE) && lead.email && (
          <Button asChild variant="outline"><Link href={`/email/compose?type=Lead&ids=${lead.id}`}>Email</Link></Button>
        )}
        <FollowControl entityType="Lead" entityId={id} />
        <CorrectControl type="Lead" id={id} />
        <FavoriteControl entityType="Lead" entityId={id} label={`${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim()} />

        <RecentMark entityType="Lead" entityId={id} label={`${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim()} />
        <DeleteControl type="Lead" id={id} name={`${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim()} />
      </PageHeader>

      {converted && (
        <div className="mb-5">
          <Alert tone="success">
            <p className="font-medium">Converted on {formatDate(lead.convertedAt)}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {lead.convertedAccount && (
                <Link href={`/accounts/${lead.convertedAccount?.id}`} className="inline-flex items-center gap-1 underline">
                  {lead.convertedAccount?.name} <ArrowRight className="h-3 w-3" />
                </Link>
              )}
              {lead.convertedOpportunity && (
                <Link href={`/opportunities/${lead.convertedOpportunity?.id}`} className="inline-flex items-center gap-1 underline">
                  {lead.convertedOpportunity?.name} <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </p>
          </Alert>
        </div>
      )}

      {disqualified && lead.disqualifiedReason && (
        <div className="mb-5">
          <Alert tone="warning">
            <p className="font-medium">Disqualified</p>
            <p className="mt-0.5 text-sm">{lead.disqualifiedReason}</p>
          </Alert>
        </div>
      )}

      {canHandoff && <Card className="mb-6"><CardHeader><CardTitle>Qualification & sales handoff</CardTitle></CardHeader><CardContent>
        {pendingHandoff ? <p>A sales handoff is pending. <Link className="underline" href="/leads/handoffs">View or cancel handoff</Link> before changing ownership, status or converting.</p> : <RequestHandoffForm leadId={id} recipients={recipients} />}
      </CardContent></Card>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Estimated value"
          help="Roughly what this deal could be worth. A guess used to size the pipeline and decide who to chase first - it is not a quoted price and nobody has agreed to it."
          value={formatMoney(lead.estimatedValue)}
        />
        <StatTile
          label="Source"
          help="How they first reached you. This is what tells you which channels are worth the spend - the second line is their industry."
          value={lead.leadSource ?? "—"}
          sublabel={lead.industry ?? undefined}
        />
        <StatTile
          label="Owner"
          help="Who is responsible for following this up. Ownership also controls visibility: a rep on OWN scope sees only the leads they own."
          value={lead.owner?.fullName ?? "—"}
        />
        <StatTile
          label="Next follow-up"
          help="When you have committed to contact them again. Shown amber when nothing is set, because an unqualified lead with no next step is how prospects go quiet."
          value={lead.nextFollowUpAt ? formatDate(lead.nextFollowUpAt) : "None set"}
          tone={lead.nextFollowUpAt ? "neutral" : "warning"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>How to reach them</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Email" help="Their work address. Used for the email you send from this record, so a wrong one fails silently.">
              {lead.email ? (
                <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {lead.email}
                </a>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Phone" help="Best number to call. Carried over to the contact record when this lead is converted.">
              {lead.phone ? (
                <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1.5 hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {lead.phone}
                </a>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="WhatsApp" help="Kept separate from Phone because it is often a different number, and because it is frequently the one that actually gets answered.">
              {lead.whatsapp ? (
                <span className="inline-flex items-center gap-1.5">
                  <MessageCircle className="h-3.5 w-3.5" /> {lead.whatsapp}
                </span>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Job title" help="What they do. The quickest read on whether this person can sign, influence, or neither.">{lead.jobTitle ?? "—"}</DetailRow>
            <DetailRow label="Company" help="Where they work, as free text. No account exists yet - converting this lead is what creates one.">{lead.companyName ?? "—"}</DetailRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where it came from</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Lead number" help="Issued automatically and never reused. Quote it when someone asks about this prospect.">{lead.leadNumber}</DetailRow>
            <DetailRow label="Source" help="The channel they arrived through - referral, website, event. Aggregated to show which channels return the spend.">{lead.leadSource ?? "—"}</DetailRow>
            <DetailRow label="Campaign" help="The marketing push that produced this lead, if any. Links what the campaign cost to what it actually returned.">
              {lead.campaign ? (
                <Link href={`/campaigns/${lead.campaign?.id}`} className="text-primary hover:underline">
                  {lead.campaign?.name}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Referred by" help="The partner credited for this introduction. Carries through to the deal on conversion, which is what earns them commission.">
              {lead.referredByPartner ? (
                <Link href={`/partners/${lead.referredByPartner?.id}`} className="text-primary hover:underline">
                  {lead.referredByPartner?.displayName}
                </Link>
              ) : (
                "—"
              )}
            </DetailRow>
            <DetailRow label="Created" help="When the lead entered the system. The clock against which a stale prospect is measured.">{formatDateTime(lead.createdAt)}</DetailRow>
          </CardContent>
        </Card>

        {(lead.icpTier || lead.region || lead.leadList || lead.googleMapsUrl || lead.website || lead.street) && (
          <Card>
            <CardHeader>
              <CardTitle>Prospecting</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="ICP tier" help="How well they fit the customer we are looking for: A - Core is the closest match, B - Broad is related trades.">{lead.icpTier ?? "—"}</DetailRow>
              <DetailRow label="Region">{lead.region ?? "—"}</DetailRow>
              <DetailRow label="Lead list" help="The list they came from, which says what contact details they had.">{lead.leadList ?? "—"}</DetailRow>
              <DetailRow label="Google rating">
                {lead.googleRating != null
                  ? `${Number(lead.googleRating).toFixed(1)} ★${lead.googleReviewCount != null ? ` from ${lead.googleReviewCount} review${lead.googleReviewCount === 1 ? "" : "s"}` : ""}`
                  : "—"}
              </DetailRow>
              <DetailRow label="Google Maps">
                {lead.googleMapsUrl ? (
                  <a href={lead.googleMapsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Open listing</a>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Website">
                {lead.website ? (
                  <a href={/^https?:\/\//.test(lead.website) ? lead.website : `https://${lead.website}`} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{lead.website}</a>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Address">{[lead.street, lead.city, lead.state, lead.postalCode, lead.country].filter(Boolean).join(", ") || "—"}</DetailRow>
              <DetailRow label="Phone class">{lead.phoneClass ?? "—"}</DetailRow>
              <DetailRow label="Phone type" help="Mobile, landline or other - filled in by whoever calls them.">{lead.phoneType ?? "—"}</DetailRow>
            </CardContent>
          </Card>
        )}
      </div>

      {lead.description && (
        <Card className="mt-6">
          <CardHeader>
            {/* The lead's own description field, distinct from the Notes panel
                below where anyone can add to the record over time. */}
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{lead.description}</p>
          </CardContent>
        </Card>
      )}


      <div className="mt-6">
        <ActivitiesPanel
          entityType="Lead"
          entityId={id}
          activities={activities}
          canWrite={can(me, PERMISSIONS.LEAD_WRITE)}
        />
      </div>
      <MarketingPanel
        entity="Lead"
        id={id}
        canWrite={can(me, PERMISSIONS.LEAD_WRITE)}
        defaultCampaignId={lead.campaign?.id ?? null}
      />

      <Timeline entityType="Lead" id={id} className="mt-6" />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <NotesSection entityType="Lead" entityId={id} notes={notes} />
        <DocumentsPanel entityType="Lead" entityId={id} documents={documents} />
      </div>

      <div className="mt-6">
        <AuditPanel entries={audit as never} />
      </div>
    </>
  );
}
