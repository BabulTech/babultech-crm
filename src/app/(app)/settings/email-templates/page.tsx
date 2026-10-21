import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden } from "@/components/ui";
import { listEmailTemplates } from "@/server/email-templates";
import { TemplateEditor } from "./template-editor";

export default async function EmailTemplatesPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="system emails" />;
  const templates = await listEmailTemplates();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="System emails"
        description="The wording of the emails the CRM sends on its own. Change the subject and message; the button, the details box, your logo and the footer are added for you."
        backTo="/settings"
        backLabel="Settings"
      />
      {templates.map((t) => (
        <TemplateEditor key={t.key} template={t} />
      ))}
    </div>
  );
}
