"use client";
import { softReload } from "@/components/soft-navigation";

import { useEffect, useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { humanize } from "@/lib/utils";
import { DEAL_STAGES, type DealStage } from "@/lib/deal-stages";
import { setPartnerDealStage } from "@/server/partner-deals";

/**
 * Where the deal stands, and moving it on - by the rules our team closes by:
 * won needs an amount, a product or service and an accepted quote; lost needs a
 * reason.
 */
export function PartnerStageControl({
  dealId,
  stage,
  hasAcceptedQuote,
}: {
  dealId: string;
  stage: string;
  hasAcceptedQuote: boolean;
}) {
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<DealStage>(stage as DealStage);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // What the last move said, carried across the reload below.
  const noticeKey = `deal-stage-notice:${dealId}`;
  useEffect(() => {
    try {
      const carried = sessionStorage.getItem(noticeKey);
      if (carried) {
        sessionStorage.removeItem(noticeKey);
        setNotice(carried);
      }
    } catch {
      // Without storage the note is lost; the page still shows the new stage.
    }
  }, [noticeKey]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await setPartnerDealStage(
        dealId,
        target,
        String(form.get("lossReason") ?? ""),
        String(form.get("competitorName") ?? ""),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const note = result.data.projectError
        ? `Moved to ${humanize(target)}. The delivery project could not be started: ${result.data.projectError}`
        : result.data.projectNumber
          ? `Won. Delivery project ${result.data.projectNumber} has been started, and your commission now has its payment date.`
          : `Moved to ${humanize(target)}.`;
      try {
        sessionStorage.setItem(noticeKey, note);
      } catch {
        // Carry on without the note.
      }
      // A full reload rather than router.refresh(): in the production build a
      // refreshed page can arrive and not be shown (the React 19.2 fault
      // described in components/deal-product-services.tsx).
      softReload();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-3"><Alert tone="danger">{error}</Alert></div>}
        {notice && <div className="mb-3"><Alert tone="success">{notice}</Alert></div>}
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Move to">
            <Select value={target} onChange={(e) => setTarget(e.target.value as DealStage)} aria-label="Stage">
              {DEAL_STAGES.map((s) => (
                <option key={s} value={s}>{humanize(s)}{s === stage ? " (now)" : ""}</option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={pending || target === stage}>
            {pending ? "Moving…" : "Move"}
          </Button>
          {target === "CLOSED_LOST" && (
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
              <Field label="Why it was lost" required>
                <Input name="lossReason" required maxLength={255} />
              </Field>
              <Field label="Who won it" hint="If you know.">
                <Input name="competitorName" maxLength={200} />
              </Field>
            </div>
          )}
          {target === "CLOSED_WON" && !hasAcceptedQuote && (
            <p className="text-sm text-amber-700 dark:text-amber-400 sm:col-span-2">
              A deal is won on an accepted quotation, and there is none on this deal yet.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
