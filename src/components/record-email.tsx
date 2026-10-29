import { getEmailComposeContext, listRecordEmails } from "@/server/email-anywhere";
import { EmailPanel } from "./record-email-panel";

/**
 * The Emails panel on a record's page: what has been sent from it, and a New
 * email button when Settings -> Email on screens switches it on for this kind
 * of record and the person's role. Renders nothing when neither applies.
 */
export async function RecordEmail({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [context, emails] = await Promise.all([getEmailComposeContext(entityType, entityId), listRecordEmails(entityType, entityId)]);
  if (!context && emails.length === 0) return null;
  return <EmailPanel context={context} emails={emails} />;
}
