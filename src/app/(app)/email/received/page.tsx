import Link from "next/link";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader, Forbidden, Card, Badge, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

const RECORD_PATH: Record<string, (id: string) => string> = {
  Prospect: (id) => `/prospects/${id}`, Lead: (id) => `/leads/${id}`, Contact: (id) => `/contacts/${id}`, Account: (id) => `/accounts/${id}`,
  Opportunity: (id) => `/opportunities/${id}`, Quotation: (id) => `/quotations/${id}`, Invoice: (id) => `/invoices/${id}`,
  Project: (id) => `/projects/${id}`, Case: (id) => `/cases/${id}`, CampaignMember: (id) => `/campaign-members/${id}`,
};

/**
 * Every email that came in to babultech.com, newest first: replies filed on
 * their record, and the ones that matched nothing, which only show here.
 */
export default async function ReceivedEmailsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.ADMIN)) return <Forbidden what="received emails" />;
  const { show } = await searchParams;
  let q = supabaseAdmin().from("email")
    .select("id, subject, fromAddress, toAddresses, sentReceivedAt, bodyText, relatedEntityType, relatedEntityId, hasAttachments")
    .eq("direction", "INBOUND").order("sentReceivedAt", { ascending: false }).limit(200);
  if (show === "unmatched") q = q.is("relatedEntityId", null);
  const { data } = await q;
  const rows = data ?? [];

  return (
    <>
      <PageHeader
        title="Received emails"
        description="Mail that came in to babultech.com, including replies to contact@babultech.com. Replies are filed on the record they answer; the ones that matched nothing are only here."
      />
      <div className="mb-4 flex gap-2 text-sm">
        <Link href="/email/received" className={!show ? "rounded-md bg-primary/10 px-3 py-1.5 font-medium text-primary" : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent"}>All</Link>
        <Link href="/email/received?show=unmatched" className={show === "unmatched" ? "rounded-md bg-primary/10 px-3 py-1.5 font-medium text-primary" : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent"}>Not matched to a record</Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing received yet" description="Replies to emails sent from the CRM appear here as they arrive." />
      ) : (
        <Card>
          <ul className="divide-y">
            {rows.map((e) => {
              const path = e.relatedEntityType && e.relatedEntityId ? RECORD_PATH[e.relatedEntityType as string]?.(e.relatedEntityId as string) : null;
              return (
                <li key={e.id as string} className="space-y-1 p-4 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.subject as string}</span>
                    {path ? <Link href={path} className="text-xs text-primary hover:underline">On the {String(e.relatedEntityType).toLowerCase()}</Link> : <Badge tone="warning">Not matched</Badge>}
                    {e.hasAttachments && <Badge tone="neutral">Has attachments</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">From {e.fromAddress as string} · to {((e.toAddresses as string[]) ?? []).join(", ")} · {formatDateTime(e.sentReceivedAt as string)}</p>
                  <details>
                    <summary className="cursor-pointer text-xs text-primary">Read it</summary>
                    <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 p-2">{(e.bodyText as string) || "(no text)"}</p>
                  </details>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
