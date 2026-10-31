"use client";
import { softGo } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MailCheck, MailX, UserPlus } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { DeleteConfirm } from "@/components/delete-confirm";
import { useCan } from "@/components/permissions";
import {
  setEmailOptOut, convertMemberToLead, type MemberConversion,
} from "@/server/campaign-members";
import { DUPLICATE_FIELD_LABEL } from "@/lib/duplicates";

/**
 * The things that are not ordinary edits.
 *
 * Converting puts somebody into the sales pipeline, unsubscribing applies to
 * every campaign for good, and removing takes them off every future audience.
 * None belongs among the text fields, where any of them could be done by
 * tabbing past it.
 */
export function MemberActions({
  id,
  name,
  optedOut,
  convertedLeadId,
  linkedContactId,
}: {
  id: string;
  name: string;
  optedOut: boolean;
  convertedLeadId: string | null;
  /** The customer's contact this member was linked to on conversion. */
  linkedContactId?: string | null;
}) {
  const canDelete = useCan("record:delete");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Set when converting found the person already on file and linked them.
  const [linked, setLinked] = useState<MemberConversion | null>(null);

  function convert() {
    if (
      !window.confirm(
        `Create a lead from ${name}?\n\nEverything on this record is copied across, ` +
          `including the campaign they came from, so the campaign stays credited. ` +
          `If they are already a lead or a contact, this member is linked to that record instead.`,
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const result = await convertMemberToLead(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.linked) {
        // Nothing new was made, so landing on a record would be a surprise:
        // say what happened here, with the way to it.
        setLinked(result.data);
        router.refresh();
        return;
      }
      // Straight to the lead: converting is the start of working them, and the
      // next thing anybody wants is the record they will work in.
      router.push(result.data.leadId ? `/leads/${result.data.leadId}` : `/contacts/${result.data.contactId}`);
      router.refresh();
    });
  }

  function toggleOptOut() {
    const resubscribing = optedOut;
    if (
      !window.confirm(
        resubscribing
          ? `Put ${name} back on the email list? Only do this if they have asked to come back.`
          : `Unsubscribe ${name} from every email campaign?`,
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const result = await setEmailOptOut(id, !optedOut);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }


  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      {linked && (
        <Alert tone="info">
          {linked.name ?? name} is already{" "}
          {linked.leadId
            ? `a lead${linked.leadNumber ? ` (${linked.leadNumber})` : ""}`
            : `a contact${linked.company ? ` at ${linked.company}` : ""}`}
          {linked.matchedOn ? `, with the same ${DUPLICATE_FIELD_LABEL[linked.matchedOn]}` : ""}. This
          member is now linked to that {linked.leadId ? "lead, so this campaign is credited on it" : "contact"},
          and no second record was made.{" "}
          <Link
            href={linked.leadId ? `/leads/${linked.leadId}` : `/contacts/${linked.contactId}`}
            className="font-medium underline"
          >
            Open the {linked.leadId ? "lead" : "contact"}
          </Link>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {!convertedLeadId && !linkedContactId && !linked && (
          <Button onClick={convert} disabled={pending}>
            <UserPlus className="h-4 w-4" />
            {pending ? "Working…" : "Convert to lead"}
          </Button>
        )}
        <Button variant="outline" onClick={toggleOptOut} disabled={pending}>
          {optedOut ? (
            <>
              <MailCheck className="h-4 w-4" /> Put back on the email list
            </>
          ) : (
            <>
              <MailX className="h-4 w-4" /> Unsubscribe from emails
            </>
          )}
        </Button>
        {canDelete && (
          <DeleteConfirm type="CampaignMember" id={id} name={name} variant="button" onDone={() => { softGo("/campaign-members"); }} />
        )}
      </div>
    </div>
  );
}
