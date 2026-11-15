import Link from "next/link";
import { Plus } from "lucide-react";
import { listProposalTemplates, listProposalSections } from "@/server/proposals";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Badge, Button, Forbidden } from "@/components/ui";
import { LibrarySection } from "./template-forms";

export default async function ProposalTemplatesPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SALES_SETUP)) return <Forbidden what="proposal templates" />;
  const [templates, sections] = await Promise.all([listProposalTemplates(true), listProposalSections()]);
  return (
    <>
      <PageHeader title="Proposal templates" description="What each offering's proposal says. A proposal copies its template and fills in the customer's details; salespeople then edit it for that customer.">
        <Button asChild variant="outline"><Link href="/offerings">Offerings</Link></Button>
        <Button asChild><Link href="/proposals/templates/new"><Plus className="h-4 w-4" /> New template</Link></Button>
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Templates</CardTitle></CardHeader>
          <CardContent className="divide-y p-0">
            {templates.map((t) => (
              <Link key={t.id} href={`/proposals/templates/${t.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-muted/40">
                <div>
                  <div className="font-medium">{t.name} {!t.active && <Badge>Not in use</Badge>}</div>
                  <div className="text-xs text-muted-foreground">{t.offering?.name ?? "Any offering"} · {t.sectionCount} sections · valid {t.validDays} days</div>
                </div>
                <span className="text-sm text-primary">Edit</span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Shared sections</CardTitle></CardHeader>
          <CardContent className="space-y-2 p-0">
            <p className="px-4 pt-1 text-sm text-muted-foreground">Written once and used by many templates - About us, Terms, Support. Changing one changes every proposal created afterwards.</p>
            <div className="divide-y">
              {sections.map((s) => <LibrarySection key={s.id} id={s.id} name={s.name} body={s.body} />)}
              <LibrarySection id={null} name="" body="" />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
