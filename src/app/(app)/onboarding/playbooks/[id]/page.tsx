import { notFound } from "next/navigation";
import { getPlaybook } from "@/server/onboarding";
import { listOfferings } from "@/server/offerings";
import { supabaseAdmin } from "@/lib/supabase";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Forbidden } from "@/components/ui";
import { PlaybookForm, StepList } from "../playbook-forms";

export default async function PlaybookPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SALES_SETUP)) return <Forbidden what="onboarding playbooks" />;
  const { id } = await params;
  const [pb, offerings, users] = await Promise.all([
    getPlaybook(id),
    listOfferings(),
    supabaseAdmin().from("app_user").select("id, fullName").eq("status", "ACTIVE").is("deletedAt", null).is("partnerId", null).or("userType.is.null,userType.eq.INTERNAL").order("fullName"),
  ]);
  if (!pb) notFound();
  return (
    <>
      <PageHeader backTo="/onboarding/playbooks" backLabel="Back to playbooks" title={pb.name} description="Changes apply to onboardings started from now on; ones already running keep their steps." />
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Playbook</CardTitle></CardHeader>
          <CardContent>
            <PlaybookForm id={pb.id} offerings={offerings} defaults={{ name: pb.name, offeringId: pb.offeringId, description: pb.description, targetDays: pb.targetDays, active: pb.active }} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Steps</CardTitle></CardHeader>
          <CardContent><StepList playbookId={pb.id} steps={pb.steps} users={users.data ?? []} /></CardContent>
        </Card>
      </div>
    </>
  );
}
