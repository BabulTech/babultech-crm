"use client";
import { softReload } from "@/components/soft-navigation";

import { useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { FormDialog } from "@/components/form-dialog";
import { INTERACTION_TYPES } from "@/lib/marketing";
import { logTouch } from "@/server/marketing";

/** Log a campaign touch by hand: an event they came to, a webinar, a call. */
export function LogTouchButton({
  leadId,
  contactId,
  campaigns,
  defaultCampaignId,
}: {
  leadId: string | null;
  contactId: string | null;
  campaigns: { id: string; name: string }[];
  defaultCampaignId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  // A container and a button rather than a <form>: a submit inside the app's
  // client tree also fires a POST of its own (see components/filter-form.tsx),
  // which cut this action's response off and left the dialog spinning.
  function submit(root: HTMLElement) {
    const fd = new Map<string, string>();
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]").forEach((el) => fd.set(el.name, el.value));
    const at = String(fd.get("occurredAt") || today);
    start(async () => {
      setError(null);
      const result = await logTouch({
        leadId,
        contactId,
        campaignId: String(fd.get("campaignId") || "") || null,
        interactionType: String(fd.get("interactionType")),
        occurredAt: new Date(at).toISOString(),
        details: String(fd.get("details") ?? ""),
      });
      if (!result.ok) return setError(result.error);
      // A full reload rather than router.refresh(): on the lead page the
      // client router intermittently dropped the refresh (in and out of a
      // transition alike), leaving the new touch unshown. A reload is about a
      // second and always shows it.
      softReload();
    });
  }


  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Log a touch
      </Button>
      <FormDialog open={open} onOpenChange={setOpen} title="Log a campaign touch">
        <div className="space-y-4" ref={rootRef}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="What happened" required>
            <Select name="interactionType" defaultValue="EVENT_ATTENDED">
              {INTERACTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Campaign">
            <Select name="campaignId" defaultValue={defaultCampaignId ?? ""}>
              <option value="">No campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="When" required>
            <Input name="occurredAt" type="datetime-local" defaultValue={today} max={today} />
          </Field>
          <Field label="Notes">
            <Textarea name="details" rows={3} maxLength={4000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" disabled={pending} onClick={() => rootRef.current && submit(rootRef.current)}>
              {pending ? "Saving…" : "Log touch"}
            </Button>
          </div>
        </div>
      </FormDialog>
    </>
  );
}
