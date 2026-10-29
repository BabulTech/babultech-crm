import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { supabaseServer } from "@/lib/supabase";
import { one } from "@/lib/decimal";
import {
  PageHeader, Forbidden, Alert, Badge, StatTile, Card, CardHeader, CardTitle,
  CardContent, Table, THead, TBody, TR, TH, TD, EmptyState,
} from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import { loadProspectRecipients } from "@/lib/prospect-recipients";
import { AutoRefresh } from "@/components/auto-refresh";

/**
 * How one send performed.
 *
 * Clicks lead, then opens. An open can be a mail client pre-fetching an image,
 * and an image blocker can hide a real one, so the open rate is soft in both
 * directions. A click is somebody deciding to do something.
 *
 * Every figure is counted from the activities listed on the page rather than
 * read from a stored total, so the summary and the list cannot disagree.
 */
export default async function SendPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ queued?: string }>;
}) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.LEAD_READ)) return <Forbidden what="email sends" />;

  const [{ id }, { queued: justQueued }] = await Promise.all([params, searchParams]);
  const db = await supabaseServer();

  const { data: batch } = await db
    .from("email_batch")
    .select(
      `id, subject, bodyText, sentAt, skippedCount, skippedReasons,
       sentBy:app_user!email_batch_sentById_fkey ( fullName )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!batch) notFound();

  const { data: rows } = await db
    .from("activity")
    .select(
      `id, toAddress, sentAt, deliveredAt, openedAt, clickedAt, bouncedAt,
       unsubscribedAt, openCount, clickCount, failReason, relatedEntityType, relatedEntityId`,
    )
    .eq("batchId", id)
    .order("createdAt");

  const activities = rows ?? [];

  // The names, so the list reads as people rather than addresses. A send goes
  // to leads, contacts or campaign members, so each is looked up where it lives.
  const idsOf = (type: string) =>
    activities.filter((a) => ((a.relatedEntityType as string) ?? "Lead") === type).map((a) => a.relatedEntityId as string);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const [{ data: leads }, { data: contacts }, { data: members }, prospects] = await Promise.all([
    db.from("lead").select("id, firstName, lastName, companyName").in("id", idsOf("Lead").length ? idsOf("Lead") : none),
    db.from("contact").select("id, firstName, lastName, account ( name )").in("id", idsOf("Contact").length ? idsOf("Contact") : none),
    db.from("campaign_member").select("id, firstName, lastName, companyName").in("id", idsOf("CampaignMember").length ? idsOf("CampaignMember") : none),
    loadProspectRecipients(db, idsOf("Prospect")),
  ]);
  const leadById = new Map<string, { id: string; firstName: string; lastName: string | null; companyName: string | null; href: string }>();
  for (const p of prospects) leadById.set(p.id, { id: p.id, firstName: p.firstName || p.companyName, lastName: p.firstName ? p.lastName : null, companyName: p.companyName, href: `/prospects/${p.id}` });
  for (const l of leads ?? []) leadById.set(l.id as string, { id: l.id as string, firstName: l.firstName as string, lastName: l.lastName as string | null, companyName: l.companyName as string | null, href: `/leads/${l.id}` });
  for (const m of members ?? []) leadById.set(m.id as string, { id: m.id as string, firstName: m.firstName as string, lastName: m.lastName as string | null, companyName: m.companyName as string | null, href: `/campaign-members/${m.id}` });
  for (const c of contacts ?? []) {
    const account = (Array.isArray(c.account) ? c.account[0] : c.account) as { name?: string } | null;
    leadById.set(c.id as string, { id: c.id as string, firstName: c.firstName as string, lastName: c.lastName as string | null, companyName: account?.name ?? null, href: `/contacts/${c.id}` });
  }

  const count = (test: (a: (typeof activities)[number]) => boolean) =>
    activities.filter(test).length;

  const delivered = count((a) => Boolean(a.deliveredAt));
  const opened = count((a) => Boolean(a.openedAt));
  const clicked = count((a) => Boolean(a.clickedAt));
  const bounced = count((a) => Boolean(a.bouncedAt));
  const unsubscribed = count((a) => Boolean(a.unsubscribedAt));
  const failed = count((a) => Boolean(a.failReason));
  const sent = count((a) => Boolean(a.sentAt));
  // Written when the send was made and sent from the background since.
  const waiting = count((a) => !a.sentAt && !a.failReason);

  const rate = (n: number) =>
    activities.length === 0 ? "—" : `${Math.round((n / activities.length) * 100)}%`;

  const skippedReasons = (batch.skippedReasons as string[] | null) ?? [];
  const sentBy = one(batch.sentBy as never) as { fullName?: string } | null;

  return (
    <>
      <PageHeader
        backTo="/leads/email/sends"
        backLabel="Back to sends"
        title={batch.subject as string}
        description={
          `Sent ${formatDateTime(batch.sentAt as string)}` +
          (sentBy?.fullName ? ` by ${sentBy.fullName}` : "")
        }
      />

      {waiting > 0 ? (
        <div className="mb-5">
          <AutoRefresh />
          <Alert tone="info">
            <span className="font-medium">Sending: {sent} of {activities.length} gone, {waiting} still to go.</span>{" "}
            The emails go out in the background, so you can leave this page.
          </Alert>
        </div>
      ) : justQueued ? (
        <div className="mb-5">
          <Alert tone="success">
            <span className="font-medium">Sent to {sent} {sent === 1 ? "person" : "people"}.</span> Opens and clicks arrive
            over the next minutes and hours, so this page fills in as they do.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Sent" value={String(sent)} sublabel={waiting > 0 ? `${waiting} still to go` : undefined} />
        <StatTile label="Delivered" value={String(delivered)} sublabel={rate(delivered)} tone="success" />
        {/* Clicks before opens, because clicks are the number that means something. */}
        <StatTile label="Clicked" value={String(clicked)} sublabel={rate(clicked)} tone="info" />
        <StatTile label="Opened" value={String(opened)} sublabel={rate(opened)} />
        <StatTile
          label="Bounced"
          value={String(bounced)}
          sublabel={rate(bounced)}
          tone={bounced > 0 ? "warning" : "neutral"}
        />
      </div>

      <div className="mt-4">
        <Alert tone="info">
          <span className="font-medium">Read the open rate carefully.</span> Some mail clients fetch
          images automatically, which counts as an open nobody made; others block them, hiding opens
          that really happened. Clicks are the number to trust.
        </Alert>
      </div>

      {(unsubscribed > 0 || failed > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {unsubscribed > 0 && (
            <StatTile
              label="Unsubscribed"
              value={String(unsubscribed)}
              sublabel="Suppressed everywhere, not only here"
              tone="warning"
            />
          )}
          {failed > 0 && <StatTile label="Failed to send" value={String(failed)} tone="danger" />}
        </div>
      )}

      {skippedReasons.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Left out of this send ({batch.skippedCount as number})</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Recorded here because somebody who was skipped has no row below to explain itself.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {skippedReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Who got it, and what they did</CardTitle>
        </CardHeader>
        {activities.length === 0 ? (
          <CardContent>
            <EmptyState title="Nothing was sent" description="This send produced no messages." />
          </CardContent>
        ) : (
          <CardContent className="px-0">
            <Table>
              <THead>
                <TR>
                  <TH>Person</TH>
                  <TH priority="secondary">Address</TH>
                  <TH>Delivered</TH>
                  <TH className="text-right">Opens</TH>
                  <TH className="text-right">Clicks</TH>
                  <TH>Outcome</TH>
                </TR>
              </THead>
              <TBody>
                {activities.map((a) => {
                  const lead = leadById.get(a.relatedEntityId as string);
                  return (
                    <TR key={a.id as string}>
                      <TD className="text-sm font-medium">
                        {lead ? (
                          <Link href={lead.href} className="hover:underline">
                            {lead.firstName} {lead.lastName && lead.lastName !== "-" ? lead.lastName : ""}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {lead?.companyName && (
                          <p className="text-xs font-normal text-muted-foreground">
                            {lead.companyName}
                          </p>
                        )}
                      </TD>
                      <TD className="text-sm" priority="secondary">
                        {(a.toAddress as string) ?? "—"}
                      </TD>
                      <TD className="text-sm">
                        {a.deliveredAt ? formatDateTime(a.deliveredAt as string) : "—"}
                      </TD>
                      <TD className="text-right text-sm tabular-nums">
                        {(a.openCount as number) || "—"}
                      </TD>
                      <TD className="text-right text-sm font-medium tabular-nums">
                        {(a.clickCount as number) || "—"}
                      </TD>
                      <TD>
                        {a.failReason ? (
                          <Badge tone="danger">Failed</Badge>
                        ) : a.bouncedAt ? (
                          <Badge tone="danger">Bounced</Badge>
                        ) : a.unsubscribedAt ? (
                          <Badge tone="warning">Unsubscribed</Badge>
                        ) : a.clickedAt ? (
                          <Badge tone="success">Clicked</Badge>
                        ) : a.openedAt ? (
                          <Badge tone="info">Opened</Badge>
                        ) : a.deliveredAt ? (
                          <Badge tone="neutral">Delivered</Badge>
                        ) : !a.sentAt ? (
                          <Badge tone="neutral">Waiting</Badge>
                        ) : (
                          <Badge tone="neutral">Sent</Badge>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </>
  );
}
