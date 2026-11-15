import Link from "next/link";
import { listOfferings } from "@/server/offerings";
import { listPlaybooks } from "@/server/onboarding";
import { listProposalTemplates } from "@/server/proposals";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Button, Forbidden } from "@/components/ui";
import { AddOffering, OfferingRow } from "./offering-rows";

export default async function OfferingsPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SALES_SETUP)) return <Forbidden what="offerings" />;
  const [offerings, playbooks, templates] = await Promise.all([listOfferings(true), listPlaybooks(), listProposalTemplates(true)]);
  return (
    <>
      <PageHeader title="Offerings" description="What kind of sale a deal is. Each offering has its own proposal templates and onboarding playbook.">
        <Button asChild variant="outline"><Link href="/proposals/templates">Proposal templates</Link></Button>
        <Button asChild variant="outline"><Link href="/onboarding/playbooks">Onboarding playbooks</Link></Button>
      </PageHeader>
      <Card>
        <CardHeader><CardTitle>Add an offering</CardTitle></CardHeader>
        <CardContent><AddOffering /></CardContent>
      </Card>
      <Card className="mt-6">
        <CardContent className="divide-y p-0">
          {offerings.map((o) => (
            <OfferingRow key={o.id} id={o.id} name={o.name} description={o.description} active={o.active}
              playbooks={playbooks.filter((p) => p.offeringId === o.id && p.active).map((p) => p.name)}
              templates={templates.filter((t) => t.offeringId === o.id && t.active).map((t) => t.name)} />
          ))}
        </CardContent>
      </Card>
    </>
  );
}
