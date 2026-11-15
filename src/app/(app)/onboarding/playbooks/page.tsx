import Link from "next/link";
import { listPlaybooks } from "@/server/onboarding";
import { listOfferings } from "@/server/offerings";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, Forbidden } from "@/components/ui";
import { PlaybookForm } from "./playbook-forms";

export default async function PlaybooksPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SALES_SETUP)) return <Forbidden what="onboarding playbooks" />;
  const [playbooks, offerings] = await Promise.all([listPlaybooks(), listOfferings()]);
  return (
    <>
      <PageHeader backTo="/onboarding" backLabel="Back to onboarding" title="Onboarding playbooks" description="The steps a new customer goes through, per offering. Winning a deal starts the playbook for its offering." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardContent className="divide-y p-0">
            {playbooks.length === 0 && <p className="p-5 text-sm text-muted-foreground">No playbooks yet.</p>}
            {playbooks.map((p) => (
              <Link key={p.id} href={`/onboarding/playbooks/${p.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-muted/40">
                <div>
                  <div className="font-medium">{p.name} {!p.active && <Badge>Not in use</Badge>}</div>
                  <div className="text-xs text-muted-foreground">{p.offering?.name ?? "No offering"} · {p.stepCount} steps{p.targetDays ? ` · live in ${p.targetDays} days` : ""}</div>
                </div>
                <span className="text-sm text-primary">Edit</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>New playbook</CardTitle></CardHeader>
          <CardContent><PlaybookForm id={null} offerings={offerings} /></CardContent>
        </Card>
      </div>
    </>
  );
}
