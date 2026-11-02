import { requireUser } from "@/lib/authz";
import { getPartnerProfile } from "@/server/portal";
import { getMyPartnerChanges } from "@/server/partner-changes";
import { ProfileEditor } from "./profile-editor";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, statusTone, DetailRow, Alert,
} from "@/components/ui";
import { PreferencesSection } from "@/components/preferences-section";
import { formatDate, formatPercent, humanize } from "@/lib/utils";
import { ChangePasswordForm } from "@/app/(app)/profile/profile-client";

export default async function PortalAccountPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  const [user, partner, changes] = await Promise.all([requireUser(), getPartnerProfile(), getMyPartnerChanges()]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Your account" description="Your partnership details and your login.">
        <Badge tone={statusTone(partner.status)}>{humanize(partner.status)}</Badge>
      </PageHeader>

      <ProfileEditor state={changes} startEditing={edit === "1"} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Partnership</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <DetailRow label="Partner">{partner.displayName}</DetailRow>
            <DetailRow label="Number">{partner.partnerNumber}</DetailRow>
            <DetailRow label="Type">{humanize(partner.partnerType)}</DetailRow>
            <DetailRow label="Tier">{humanize(partner.tier)}</DetailRow>
            <DetailRow label="Territory">{partner.territory ?? "—"}</DetailRow>
            <DetailRow label="Partner since">{formatDate(partner.startDate)}</DetailRow>
            <DetailRow label="Agreement expires">{formatDate(partner.agreementExpiryDate)}</DetailRow>
            <DetailRow label="Commission rate">
              {partner.defaultCommissionPercent ? formatPercent(partner.defaultCommissionPercent, 2) : "—"}
            </DetailRow>
            <DetailRow label="Paid in">{partner.payoutCurrencyCode}</DetailRow>
            <DetailRow label="Withholding tax">
              {partner.withholdingTaxPercent ? formatPercent(partner.withholdingTaxPercent, 2) : "None"}
            </DetailRow>
            <DetailRow label="Tax number">{partner.taxNumber ?? "—"}</DetailRow>
            <DetailRow label="Email">{partner.email ?? "—"}</DetailRow>
            <DetailRow label="Phone">{partner.phone ?? "—"}</DetailRow>
            <DetailRow label="Website">{partner.website ?? "—"}</DetailRow>
            <p className="pt-2 text-xs text-muted-foreground">
              Type, tier and agreement dates are set by your partner manager.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Your login</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <DetailRow label="Name">{user.fullName}</DetailRow>
              <DetailRow label="Email">{user.email}</DetailRow>
              <DetailRow label="Access level">Partner portal only</DetailRow>
            </CardContent>
          </Card>

          <ChangePasswordForm />

          <PreferencesSection />

          <Alert tone="info">
            This login only ever sees your own partnership. It has no access to our internal system.
          </Alert>
        </div>
      </div>
    </div>
  );
}
