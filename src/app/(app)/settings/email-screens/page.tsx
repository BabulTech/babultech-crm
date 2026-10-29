import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { PageHeader, Forbidden, Alert } from "@/components/ui";
import { listEmailScreenSettings } from "@/server/email-anywhere";
import { EmailScreensEditor } from "./email-screens-editor";

/** Which record pages offer New email, to which roles, with what default sender and template. */
export default async function EmailScreensPage() {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="settings" />;
  const data = await listEmailScreenSettings();
  return (
    <>
      <PageHeader
        backTo="/settings"
        backLabel="Back to settings"
        title="Email on screens"
        description="Turn the Emails panel on or off for each kind of record, and choose who may send from it."
      />
      <div className="mb-5">
        <Alert tone="info">
          With no roles ticked, anyone who can edit that kind of record may send. Emails already sent stay listed on the record even when sending is turned off.
        </Alert>
      </div>
      <EmailScreensEditor {...data} />
    </>
  );
}
