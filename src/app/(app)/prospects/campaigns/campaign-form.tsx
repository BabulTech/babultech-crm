"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { CHANNELS, CHANNEL_LABELS } from "@/lib/prospect-outreach";
import { saveProspectCampaign } from "@/server/prospect-campaigns";

export interface CampaignValues {
  id?: string; name?: string; description?: string | null; status?: string; defaultChannel?: string | null;
  followupDays?: number; startDate?: string | null; endDate?: string | null;
}

export function CampaignForm({ values, onCancel }: { values?: CampaignValues; onCancel: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const get = (k: string) => String(f.get(k) ?? "");
      start(async () => {
        const result = await saveProspectCampaign(values?.id ?? null, {
          name: get("name"), description: get("description"), status: get("status") as never, defaultChannel: get("defaultChannel") as never,
          followupDays: get("followupDays") as never, startDate: get("startDate"), endDate: get("endDate"),
        });
        if (result.ok) window.location.assign(`/prospects/campaigns/${result.data.id}`);
        else setError(result.error);
      });
    }}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" required><Input name="name" defaultValue={values?.name ?? ""} required maxLength={200} placeholder="Ontario dentists - October calls" /></Field>
      <Field label="Description"><Textarea name="description" rows={2} defaultValue={values?.description ?? ""} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Outreach channel" help="Fix every touch to one channel, or leave it open and choose per call or email.">
          <Select name="defaultChannel" defaultValue={values?.defaultChannel ?? ""}>
            <option value="">Any channel</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </Select>
        </Field>
        <Field label="Follow up after (working days)" help="When an email is logged, the follow-up task is due this many working days later.">
          <Input name="followupDays" type="number" min="1" max="60" defaultValue={values?.followupDays ?? 3} />
        </Field>
        <Field label="Starts"><Input name="startDate" type="date" defaultValue={values?.startDate ?? ""} /></Field>
        <Field label="Ends"><Input name="endDate" type="date" defaultValue={values?.endDate ?? ""} /></Field>
        {values?.id && (
          <Field label="Status">
            <Select name="status" defaultValue={values.status ?? "ACTIVE"}>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="COMPLETED">Completed</option>
            </Select>
          </Field>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : values?.id ? "Save" : "Create campaign"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function NewCampaign() {
  const [open, setOpen] = useState(false);
  if (!open) return <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New campaign</Button>;
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader><CardTitle>New outreach campaign</CardTitle></CardHeader>
      <CardContent><CampaignForm onCancel={() => setOpen(false)} /></CardContent>
    </Card>
  );
}
