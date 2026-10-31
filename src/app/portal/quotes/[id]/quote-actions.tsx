"use client";
import { softReload, softGo } from "@/components/soft-navigation";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  askPartnerQuoteApproval, withdrawPartnerQuoteApproval, markPartnerQuoteSent,
  decidePartnerQuote, revisePartnerQuote,
} from "@/server/partner-quotes";
import { Button, Card, CardContent, CardHeader, CardTitle, Alert } from "@/components/ui";
import { formatDate } from "@/lib/utils";

/**
 * Where one of the partner's quotes is, and the next step they can take.
 *
 * A quote the partner prepares goes to their partner manager for approval
 * first; once approved it is emailed or marked as sent; then the customer's
 * answer is recorded. Accepting puts the quote's products and services on the
 * deal - which is what lets it be won - and from then on the deal is what the
 * customer accepted.
 */
export function PartnerQuoteActions({
  quoteId,
  quoteNumber,
  status,
  approvalStatus,
  approvalNote,
  approvalRequestedAt,
  approvalDecidedAt,
  preparedByPartner,
  expired,
  dealId,
  dealClosed,
}: {
  quoteId: string;
  quoteNumber: string;
  status: string;
  approvalStatus: string;
  approvalNote: string | null;
  approvalRequestedAt: string | null;
  approvalDecidedAt: string | null;
  /** Prepared by the partner (so it needs approval), rather than by BabulTech. */
  preparedByPartner: boolean;
  expired: boolean;
  dealId: string;
  dealClosed: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The note from the last action, carried across the reload below.
  const noticeKey = `portal-quote-notice:${quoteId}`;
  useEffect(() => {
    try {
      const carried = sessionStorage.getItem(noticeKey);
      if (carried) {
        sessionStorage.removeItem(noticeKey);
        setNotice(carried);
      }
    } catch {
      // Storage can be unavailable, as in a private window; the page stands without the note.
    }
  }, [noticeKey]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      // A full reload rather than router.refresh(), which can deliver a page
      // that is never shown (the React 19.2 fault described in
      // components/deal-product-services.tsx).
      try {
        sessionStorage.setItem(noticeKey, success);
      } catch {
        // Without storage the note is lost; the reloaded page still says where the quote is.
      }
      softReload();
    });
  };

  function revise() {
    setError(null);
    startTransition(async () => {
      const result = await revisePartnerQuote(quoteId);
      if (result.ok) softGo(`/portal/quotes/${result.data.id}`);
      else setError(result.error);
    });
  }

  const reviseButton = (
    <Button variant="outline" className="w-full" disabled={pending} onClick={revise}>
      Create a revision
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where this quote is</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {dealClosed && !["ACCEPTED", "REVISED"].includes(status) && (
          <p className="text-muted-foreground">The deal is closed, so this quote stays as it is.</p>
        )}

        {!dealClosed && status === "DRAFT" && preparedByPartner && (
          <>
            {approvalStatus === "REJECTED" && approvalNote && (
              <Alert tone="warning">
                Sent back by your partner manager: {approvalNote}
              </Alert>
            )}
            <p className="text-muted-foreground">
              A draft. Your partner manager approves every quote you prepare before it goes to the
              customer{approvalStatus === "REJECTED" ? " - change it, then ask again." : "."}
            </p>
            <Button
              className="w-full"
              disabled={pending || expired}
              onClick={() =>
                run(() => askPartnerQuoteApproval(quoteId), "Sent for approval. You will see here when it is approved.")
              }
            >
              {pending ? "Working…" : "Ask for approval"}
            </Button>
            {expired && (
              <p className="text-xs text-destructive">
                The valid-until date has passed - change it before asking.
              </p>
            )}
          </>
        )}

        {!dealClosed && status === "DRAFT" && !preparedByPartner && (
          <>
            <p className="text-muted-foreground">
              Prepared by BabulTech, so it needs no approval. Email it to the customer below, or mark
              it as sent if it went another way.
            </p>
            <Button
              className="w-full"
              disabled={pending || expired}
              onClick={() => run(() => markPartnerQuoteSent(quoteId), "Marked as sent. The deal has moved to Quote Submitted.")}
            >
              Mark as sent
            </Button>
          </>
        )}

        {!dealClosed && status === "UNDER_REVIEW" && (
          <>
            <p className="text-muted-foreground">
              Waiting for your partner manager&apos;s approval
              {approvalRequestedAt ? ` since ${formatDate(approvalRequestedAt)}` : ""}. It can go to
              the customer once it is approved.
            </p>
            <Button
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={() =>
                run(() => withdrawPartnerQuoteApproval(quoteId), "Withdrawn. It is a draft again, and you can change it.")
              }
            >
              Withdraw the request to change it
            </Button>
          </>
        )}

        {!dealClosed && status === "APPROVED" && (
          <>
            <p className="text-emerald-600 dark:text-emerald-400">
              Approved{approvalDecidedAt ? ` on ${formatDate(approvalDecidedAt)}` : ""}.
            </p>
            {approvalNote && <p className="text-muted-foreground">Note from your partner manager: {approvalNote}</p>}
            <p className="text-muted-foreground">
              Email it to the customer below, or mark it as sent if it went another way. Changing it
              now means it needs approving again.
            </p>
            <Button
              className="w-full"
              disabled={pending || expired}
              onClick={() => run(() => markPartnerQuoteSent(quoteId), "Marked as sent. The deal has moved to Quote Submitted.")}
            >
              Mark as sent
            </Button>
            {expired && (
              <p className="text-xs text-destructive">The valid-until date has passed - change it before sending.</p>
            )}
          </>
        )}

        {!dealClosed && status === "SENT" && (
          <>
            <p className="text-muted-foreground">
              With the customer. Accepting puts this quote&apos;s products and services on the deal in
              place of what is there, so the deal&apos;s value - and your commission - becomes the
              quote&apos;s. It moves the deal to Verbal Confirmation, and is what lets it be won.
            </p>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Record that the customer accepted ${quoteNumber}?\n\n` +
                        "The deal's products and services will be replaced by this quote's, its value will become the quote total, and they can no longer be changed from the portal.",
                    )
                  ) {
                    return;
                  }
                  run(
                    () => decidePartnerQuote(quoteId, "ACCEPTED"),
                    "Accepted. The deal now carries this quote's products and services, and can be won.",
                  );
                }}
              >
                Accepted
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={pending}
                onClick={() => run(() => decidePartnerQuote(quoteId, "REJECTED"), "Marked as rejected.")}
              >
                Rejected
              </Button>
            </div>
            {reviseButton}
          </>
        )}

        {status === "ACCEPTED" && (
          <p className="text-emerald-600 dark:text-emerald-400">
            Accepted - this is the binding version. The deal carries its products and services
            {dealClosed ? "." : ", and can now be won."}
          </p>
        )}

        {!dealClosed && status === "REJECTED" && (
          <>
            <p className="text-muted-foreground">
              Rejected. If you are re-quoting, create a revision - it replaces this version and keeps
              the history of what was offered. If they are not buying, close the deal as lost with
              the reason.
            </p>
            {reviseButton}
          </>
        )}

        {!dealClosed && status === "EXPIRED" && (
          <>
            <p className="text-muted-foreground">Expired. Create a revision with new dates to quote again.</p>
            {reviseButton}
          </>
        )}

        {status === "REVISED" && (
          <p className="text-muted-foreground">Replaced by a newer version - see Versions.</p>
        )}

        <Button asChild variant="ghost" size="sm" className="w-full">
          <Link href={`/portal/deals/${dealId}`}>Open the deal</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
