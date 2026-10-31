"use client";
import { softReload } from "@/components/soft-navigation";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sendQuotation, decideQuotation, reviseQuotation, decideQuotationApproval, requestQuotationApproval } from "@/server/quotations";
import { Button, Card, CardContent, CardHeader, CardTitle, Alert, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";

const EDITABLE = ["DRAFT", "UNDER_REVIEW", "APPROVED"];

export interface QuoteApproval {
  /** The partner who prepared it; null for one of ours, which needs no approval. */
  preparedBy: string | null;
  approvalStatus: string;
  note: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

/**
 * The quote's lifecycle in one panel. Each transition is a distinct server
 * action because each has different consequences — sending moves the deal to
 * Quote Submitted, accepting is what unlocks Closed Won.
 *
 * A quote a partner prepared goes out only once one of our approvers has
 * approved it (20260928000006), so until then this panel is where it is
 * approved or sent back, not sent.
 */
export function QuoteActions({
  quoteId,
  status,
  expiryDate,
  opportunityId,
  opportunityStage,
  approval,
  canApprove = false,
  ruleReason = null,
}: {
  quoteId: string;
  status: string;
  expiryDate: string;
  /** The deal this quote belongs to, so a rejection can point at it. */
  opportunityId: string | null;
  opportunityStage: string | null;
  approval?: QuoteApproval;
  /** Whether the reader may approve quotations. */
  canApprove?: boolean;
  /** Why an approval rule holds this quote back, or null. */
  ruleReason?: string | null;
}) {
  const [sendBackReason, setSendBackReason] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The note from the last action, carried across the reload below.
  const noticeKey = `quote-notice:${quoteId}`;
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

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        // A full reload rather than router.refresh(). In the production build
        // the refreshed page can arrive and never be shown - the React 19.2
        // fault described in components/deal-product-services.tsx - which
        // left "Mark as sent" saying Sent while still offering to send it.
        try {
          if (success) sessionStorage.setItem(noticeKey, success);
        } catch {
          // Without storage the note is lost; the reloaded page still says where the quote is.
        }
        softReload();
      } else setError(result.error ?? "Something went wrong.");
    });
  };

  const expired = new Date(expiryDate) < new Date();
  const partnerQuote = Boolean(approval?.preparedBy);
  // One of ours over an approval rule's limit, or already waiting for approval.
  const internalApproval =
    !partnerQuote && EDITABLE.includes(status) && approval?.approvalStatus !== "APPROVED" &&
    (Boolean(ruleReason) || approval?.approvalStatus === "PENDING");
  const awaitingApproval = (partnerQuote && approval?.approvalStatus !== "APPROVED") || internalApproval;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where this quote is</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {internalApproval && approval && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {approval.approvalStatus === "PENDING"
                ? `Waiting for approval${approval.requestedAt ? ` since ${formatDate(approval.requestedAt)}` : ""}. It cannot go to the customer until it is approved.`
                : "This quote needs approval before it goes to the customer."}
            </p>
            {ruleReason && <Alert tone="info">{ruleReason}</Alert>}
            {approval.approvalStatus === "REJECTED" && approval.note && (
              <Alert tone="warning">
                Sent back{approval.decidedBy ? ` by ${approval.decidedBy}` : ""}: {approval.note}
              </Alert>
            )}
            {approval.approvalStatus !== "PENDING" && (
              <Button
                className="w-full"
                disabled={pending}
                onClick={() => run(() => requestQuotationApproval(quoteId), "Sent for approval. Approvers have been told.")}
              >
                {pending ? "Working…" : "Send for approval"}
              </Button>
            )}
            {approval.approvalStatus === "PENDING" && canApprove && (
              <>
                <Button
                  className="w-full"
                  disabled={pending}
                  onClick={() => run(() => decideQuotationApproval(quoteId, true), "Approved. It can now be sent.")}
                >
                  Approve
                </Button>
                {sendingBack ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={3}
                      value={sendBackReason}
                      onChange={(e) => setSendBackReason(e.target.value)}
                      placeholder="What should be changed?"
                      aria-label="Why it is being sent back"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        disabled={pending || !sendBackReason.trim()}
                        onClick={() => run(() => decideQuotationApproval(quoteId, false, sendBackReason), "Sent back with your reason.")}
                      >
                        Send back
                      </Button>
                      <Button variant="ghost" disabled={pending} onClick={() => setSendingBack(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full" disabled={pending} onClick={() => setSendingBack(true)}>
                    Send back
                  </Button>
                )}
              </>
            )}
            {approval.approvalStatus === "PENDING" && !canApprove && (
              <p className="text-xs text-muted-foreground">Somebody who may approve quotations has to approve it.</p>
            )}
          </div>
        )}

        {EDITABLE.includes(status) && partnerQuote && awaitingApproval && approval && (
          <div className="space-y-3">
            {approval.approvalStatus === "PENDING" ? (
              <p className="text-sm text-muted-foreground">
                Prepared by <span className="font-medium text-foreground">{approval.preparedBy}</span>, who
                asked for approval{approval.requestedAt ? ` on ${formatDate(approval.requestedAt)}` : ""}.
                It cannot go to the customer until it is approved.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Prepared by <span className="font-medium text-foreground">{approval.preparedBy}</span>, who has
                not asked for approval yet. It cannot go to the customer until it is approved.
              </p>
            )}
            {approval.approvalStatus === "REJECTED" && approval.note && (
              <Alert tone="warning">
                Sent back{approval.decidedBy ? ` by ${approval.decidedBy}` : ""}: {approval.note}
              </Alert>
            )}
            {approval.approvalStatus === "PENDING" && canApprove && (
              <>
                <Button
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => decideQuotationApproval(quoteId, true),
                      "Approved. The partner can now send it to the customer.",
                    )
                  }
                >
                  Approve
                </Button>
                {sendingBack ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={3}
                      value={sendBackReason}
                      onChange={(e) => setSendBackReason(e.target.value)}
                      placeholder="What should the partner change?"
                      aria-label="Why it is being sent back"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        disabled={pending || !sendBackReason.trim()}
                        onClick={() =>
                          run(
                            () => decideQuotationApproval(quoteId, false, sendBackReason),
                            "Sent back to the partner with your reason.",
                          )
                        }
                      >
                        Send back
                      </Button>
                      <Button variant="ghost" disabled={pending} onClick={() => setSendingBack(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full" disabled={pending} onClick={() => setSendingBack(true)}>
                    Send back to the partner
                  </Button>
                )}
              </>
            )}
            {approval.approvalStatus === "PENDING" && !canApprove && (
              <p className="text-xs text-muted-foreground">
                Somebody who may approve quotations has to approve it.
              </p>
            )}
          </div>
        )}

        {EDITABLE.includes(status) && !awaitingApproval && (
          <>
            {partnerQuote && approval?.decidedAt && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">
                Prepared by {approval.preparedBy} and approved
                {approval.decidedBy ? ` by ${approval.decidedBy}` : ""} on {formatDate(approval.decidedAt)}.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Still a draft - nothing has gone to the customer. Sending it freezes the numbers.
            </p>
            <Button
              className="w-full"
              disabled={pending || expired}
              onClick={() => run(() => sendQuotation(quoteId), "Sent. The deal has moved to Quote Submitted.")}
            >
              {pending ? "Working…" : "Mark as sent"}
            </Button>
            {expired && (
              <p className="text-xs text-destructive">
                The expiry date has passed - extend it before sending.
              </p>
            )}
          </>
        )}

        {status === "SENT" && (
          <>
            <p className="text-sm text-muted-foreground">
              With the customer. Accepting puts this quote&apos;s products and services on the deal
              in place of what is there, so the deal&apos;s value - and any partner commission -
              becomes the quote&apos;s. It moves the deal to Verbal Confirmation, and is what lets
              it be marked Closed Won.
            </p>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={pending}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Record that the customer accepted this quote?\n\n" +
                        "The deal's products and services will be replaced by this quote's, and its value will become the quote total.",
                    )
                  ) {
                    return;
                  }
                  run(
                    () => decideQuotation(quoteId, "ACCEPTED"),
                    "Accepted. The deal now carries this quote's products and services.",
                  );
                }}
              >
                Accepted
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={pending}
                onClick={() => run(() => decideQuotation(quoteId, "REJECTED"), "Marked as rejected.")}
              >
                Rejected
              </Button>
            </div>
          </>
        )}

        {status === "ACCEPTED" && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            Accepted - this is the binding version. The deal carries its products and services,
            and can now be won.
          </p>
        )}

        {/* Rejection has three meanings and the software cannot tell them
            apart: the price was wrong, the scope was wrong, or they are not
            buying. Accepting a quote moves the deal on by itself; rejecting one
            does nothing, which is correct but leaves the deal sitting in Quote
            Submitted with no prompt. That is how a pipeline fills with deals
            that died months ago and still look live.

            So the two routes are named rather than left implied. Neither is
            performed automatically - which one applies is a judgement about the
            customer, not a fact the system holds. */}
        {status === "REJECTED" && (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            <p className="text-sm">
              Rejected. Decide which of these it is, or the deal stays in the
              pipeline looking live.
            </p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Re-quoting?</span>{" "}
                Create a revision below - it supersedes this version and keeps
                the history of what was offered.
              </li>
              <li>
                <span className="font-medium text-foreground">Not buying?</span>{" "}
                Close the deal as lost. A loss reason is required, and that field
                is how you find out whether you are losing on price or on
                features.
              </li>
            </ul>
            {opportunityId &&
              opportunityStage !== "CLOSED_LOST" &&
              opportunityStage !== "CLOSED_WON" && (
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link href={`/opportunities/${opportunityId}`}>
                    Open the deal to close it out
                  </Link>
                </Button>
              )}
          </div>
        )}

        {status !== "ACCEPTED" && (
          <Button
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await reviseQuotation(quoteId);
                if (result.ok) router.push(`/quotations/${result.data.id}`);
                else setError(result.error);
              })
            }
          >
            Create a revision
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
