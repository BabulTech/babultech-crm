import { RecordEmail } from "@/components/record-email";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Pencil } from "lucide-react";
import { getCampaignMember } from "@/server/campaign-members";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Forbidden, Badge, Alert, Button,
  Card, CardHeader, CardTitle, CardContent, DetailRow,
} from "@/components/ui";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";
import { MemberActions } from "./member-actions";

/**
 * One member, as a saved record.
 *
 * This page used to render the edit form directly, so a member never looked
 * saved - it looked like a form somebody had abandoned half-way. It now reads
 * like every other record in the CRM: the facts, and an Edit button, with the
 * form on its own route.
 */
export default async function CampaignMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.LEAD_READ)) return <Forbidden what="campaign members" />;

  const { id } = await params;
  const member = await getCampaignMember(id);
  if (!member) notFound();

  const canWrite = can(me, PERMISSIONS.LEAD_WRITE);
  const name = `${member.firstName} ${member.lastName ?? ""}`.trim();

  // A dash rather than an empty cell: a blank looks like the page failed to
  // load, while a dash says plainly that nobody filled this in.
  const or = (value: string | null | undefined) => value?.trim() || "—";

  const address = [member.street, member.city, member.state, member.postalCode, member.country]
    .filter((part) => part?.trim())
    .join(", ");

  return (
    <>
      <PageHeader
        backTo="/campaign-members"
        backLabel="Back to members"
        title={name}
        description={member.companyName ?? "No company recorded"}
      >
        {member.businessType && <Badge tone="neutral">{humanize(member.businessType)}</Badge>}
        {member.companySize && <Badge tone="neutral">{humanize(member.companySize)}</Badge>}
        {member.convertedAt && (
          <Badge tone="success">{member.leadId ? "Converted to lead" : "Linked to a contact"}</Badge>
        )}
        {!member.active && <Badge tone="warning">Off the active list</Badge>}
        {canWrite && (
          <Button asChild variant="outline">
            <Link href={`/campaign-members/${member.id}/edit`}>
              <Pencil className="h-4 w-4" /> Edit
            </Link>
          </Button>
        )}
      </PageHeader>

      {member.convertedAt && member.leadId && (
        <div className="mb-5">
          <Alert tone="success">
            <span className="font-medium">This member is now a lead.</span> Converted{" "}
            {formatDate(member.convertedAt)}.{" "}
            <Link href={`/leads/${member.leadId}`} className="font-medium underline">
              Open the lead <ArrowRight className="inline h-3.5 w-3.5" />
            </Link>
          </Alert>
        </div>
      )}

      {member.convertedAt && !member.leadId && member.contactId && (
        <div className="mb-5">
          <Alert tone="success">
            <span className="font-medium">This person is already a customer&apos;s contact.</span>{" "}
            Linked {formatDate(member.convertedAt)}, so this campaign shows on their record.{" "}
            <Link href={`/contacts/${member.contactId}`} className="font-medium underline">
              Open the contact <ArrowRight className="inline h-3.5 w-3.5" />
            </Link>
          </Alert>
        </div>
      )}

      {member.emailOptOut && (
        <div className="mb-5">
          <Alert tone="warning">
            <span className="font-medium">This person has unsubscribed.</span> They are left out of
            every email campaign, and will stay out until they ask to come back.
          </Alert>
        </div>
      )}

      {member.emailBounced && (
        <div className="mb-5">
          <Alert tone="danger">
            <span className="font-medium">Mail to this address bounced.</span> Sending to it again
            damages our sending reputation, so campaigns skip it until the address is corrected.
          </Alert>
        </div>
      )}

      {canWrite && (
        <div className="mb-5">
          <MemberActions
            id={member.id}
            name={name}
            optedOut={member.emailOptOut}
            convertedLeadId={member.leadId}
            linkedContactId={member.convertedAt ? member.contactId : null}
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>The person</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DetailRow label="Name">{name}</DetailRow>
              <DetailRow label="Job title">{or(member.jobTitle)}</DetailRow>
              <DetailRow label="Email">
                {member.email ? (
                  <a href={`mailto:${member.email}`} className="text-primary hover:underline">
                    {member.email}
                  </a>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Phone">{or(member.phone)}</DetailRow>
              <DetailRow
                label="WhatsApp"
                help="Kept apart from the phone number because it is often a different one, and it is the number a campaign actually reaches them on."
              >
                {or(member.whatsapp)}
              </DetailRow>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where they work</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <DetailRow label="Company">{or(member.companyName)}</DetailRow>
              <DetailRow label="Website">
                {member.website ? (
                  <a
                    href={member.website.startsWith("http") ? member.website : `https://${member.website}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    {member.website}
                  </a>
                ) : "—"}
              </DetailRow>
              <DetailRow label="Business type">{or(member.businessType && humanize(member.businessType))}</DetailRow>
              <DetailRow label="Company size">{or(member.companySize && humanize(member.companySize))}</DetailRow>
              <DetailRow label="Address" >{address || "—"}</DetailRow>
            </CardContent>
          </Card>

          {member.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{member.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Where they came from</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <DetailRow
                label="Campaign"
                help="The campaign that produced this person. The same human on two campaigns is two member rows, so each one records a real event."
              >
                {member.campaign?.name ? (
                  <Link href={`/campaigns/${member.campaign.id}`} className="text-primary hover:underline">
                    {member.campaign.name}
                  </Link>
                ) : "—"}
              </DetailRow>
              <DetailRow
                label="Source"
                help="How we came by them — the webinar, the form, the referral."
              >
                {or(member.source && humanize(member.source))}
              </DetailRow>
              <DetailRow label="Added">{formatDate(member.createdAt)}</DetailRow>
              <DetailRow label="Owner">{or(member.owner?.fullName)}</DetailRow>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contact history</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <DetailRow
                label="Last contacted"
                help="Shown when building an audience, so nobody is mailed three weeks running by accident."
              >
                {member.lastCampaignRunAt ? formatDateTime(member.lastCampaignRunAt) : "Never"}
              </DetailRow>
              {member.lastCampaign?.name && (
                <DetailRow label="By">{member.lastCampaign.name}</DetailRow>
              )}
              <DetailRow label="Campaigns reached them">{member.campaignCount}</DetailRow>
            </CardContent>
          </Card>
          <RecordEmail entityType="CampaignMember" entityId={id} />
        </div>
      </div>
    </>
  );
}
