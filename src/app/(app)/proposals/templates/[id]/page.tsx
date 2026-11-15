import { notFound } from "next/navigation";
import { getProposalTemplate, listProposalSections } from "@/server/proposals";
import { listOfferings } from "@/server/offerings";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { TemplateEditor } from "../template-forms";

export default async function ProposalTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.SALES_SETUP)) return <Forbidden what="proposal templates" />;
  const { id } = await params;
  const isNew = id === "new";
  const [template, offerings, library] = await Promise.all([isNew ? null : getProposalTemplate(id), listOfferings(), listProposalSections()]);
  if (!isNew && !template) notFound();
  return (
    <>
      <PageHeader backTo="/proposals/templates" backLabel="Back to templates" title={template?.name ?? "New proposal template"} description="Proposals already created keep their own text." />
      <div className="max-w-4xl">
        <TemplateEditor
          id={template?.id ?? null}
          offerings={offerings}
          library={library.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
          defaults={template
            ? { name: template.name, offeringId: template.offeringId, validDays: template.validDays, active: template.active, sections: template.sections }
            : { name: "", offeringId: null, validDays: 30, active: true, sections: [{ kind: "TEXT", title: "Introduction", body: "<p>Dear {{contact.firstName}},</p>" }, { kind: "PRICING", title: "Pricing" }] }}
        />
      </div>
    </>
  );
}
