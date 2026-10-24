import Link from "next/link";
import { getCorrectionState } from "@/server/corrections";
import { CorrectButton } from "@/components/correct-button";
import { CorrectionGate } from "@/components/correction-gate";
import { notFound } from "next/navigation";
import { getLead, getFormOptions } from "@/server/crm";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Alert, Button , Forbidden} from "@/components/ui";
import { serialize, formatDate } from "@/lib/utils";
import { LeadForm, type LeadDefaults } from "../../lead-form";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  if (!can(user, PERMISSIONS.LEAD_WRITE)) return <Forbidden what="leads" />;
  const [lead, options] = await Promise.all([getLead(id), getFormOptions()]);
  if (!lead) notFound();

  // Spec §13: conversion freezes the lead. Show where it went instead of a
  // form - unless an administrator has opened a correction on it.
  const correction = await getCorrectionState("Lead", id);
  if (lead.status === "CONVERTED" && !correction?.open) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader
        backTo={`/leads/${id}`}
        backLabel="Back to the lead"
        title={`${lead.firstName} ${lead.lastName}`} description={lead.leadNumber} />
        <Alert tone="info">
          This lead was converted on {formatDate(lead.convertedAt as string | null)} and is now
          read-only. Edit the records it became instead.
        </Alert>
        <div className="mt-4 flex gap-2">
          {lead.convertedAccount && (
            <Button asChild variant="outline">
              <Link href={`/accounts/${lead.convertedAccount.id}`}>{lead.convertedAccount.name}</Link>
            </Button>
          )}
          {lead.convertedOpportunity && (
            <Button asChild variant="outline">
              <Link href={`/opportunities/${lead.convertedOpportunity.id}`}>
                {lead.convertedOpportunity.name}
              </Link>
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link href="/leads">Back to leads</Link>
          </Button>
        </div>
        {correction?.isAdmin && (
          <div className="mt-6">
            <p className="mb-2 text-sm text-muted-foreground">As an administrator you can still correct it. Say what was wrong first.</p>
            <CorrectButton type="Lead" id={id} inline />
          </div>
        )}
      </div>
    );
  }

  const defaults = serialize({
    id: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    companyName: lead.companyName,
    jobTitle: lead.jobTitle,
    email: lead.email,
    phone: lead.phone,
    whatsapp: lead.whatsapp,
    industry: lead.industry,
    website: lead.website,
    icpTier: lead.icpTier == null ? null : String(lead.icpTier),
    region: lead.region == null ? null : String(lead.region),
    leadList: lead.leadList == null ? null : String(lead.leadList),
    googleRating: lead.googleRating == null ? null : String(lead.googleRating),
    googleReviewCount: lead.googleReviewCount == null ? null : String(lead.googleReviewCount),
    googleMapsUrl: lead.googleMapsUrl == null ? null : String(lead.googleMapsUrl),
    phoneClass: lead.phoneClass == null ? null : String(lead.phoneClass),
    phoneType: lead.phoneType == null ? null : String(lead.phoneType),
    businessType: lead.businessType,
    companySize: lead.companySize,
    street: lead.street,
    city: lead.city,
    state: lead.state,
    postalCode: lead.postalCode,
    country: lead.country,
    leadSource: lead.leadSource,
    campaignId: lead.campaignId,
    referredByPartnerId: lead.referredByPartnerId,
    ownerUserId: lead.ownerUserId,
    status: lead.status,
    rating: lead.rating,
    estimatedValue: lead.estimatedValue,
    description: lead.description,
    nextFollowUpAt: lead.nextFollowUpAt,
    disqualifiedReason: lead.disqualifiedReason,
  }) as unknown as LeadDefaults;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        backTo={`/leads/${id}`}
        backLabel="Back to the lead"
        title={`${lead.firstName} ${lead.lastName}`}
        description={lead.leadNumber}
      >
        {lead.status !== "CONVERTED" && (
          <Button asChild variant="secondary">
            <Link href={`/leads/${lead.id}/convert`}>Convert…</Link>
          </Button>
        )}
      </PageHeader>
      <CorrectionGate type="Lead" id={id}>
        <LeadForm
          options={serialize({
            users: options.users,
            campaigns: options.campaigns,
            partners: options.partners,
          })}
          defaults={defaults}
          currentUserId={user.id}
        />
      </CorrectionGate>
    </div>
  );
}
