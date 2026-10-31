"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { saveWebhook, deleteWebhook, rotateWebhookSecret, sendTestWebhook, retryDelivery, type Webhook } from "@/server/integrations";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { formatDateTime } from "@/lib/utils";

type Draft = { id: string | null; name: string; url: string; events: string[]; active: boolean };
const BLANK: Draft = { id: null, name: "", url: "", events: [], active: true };

/** Webhooks: add, edit, switch off, test, rotate the secret, remove. */
export function WebhooksPanel({ webhooks }: { webhooks: Webhook[] }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, start] = useTransition();

  // A full reload after each change: see components/log-touch-button.tsx.
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      setMessage(null);
      const result = await fn();
      if (!result.ok) return setMessage({ tone: "danger", text: result.error ?? "That did not work." });
      setMessage({ tone: "success", text: done });
      window.setTimeout(() => softReload(), 600);
    });

  const save = () => draft && act(() => saveWebhook(draft), draft.id ? "Webhook saved." : "Webhook added.");

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Webhooks</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            We post a signed JSON message to your address when an event happens. Check the X-BabulTech-Signature header: it is
            sha256= and the HMAC of the timestamp header, a dot, and the body, keyed with the webhook&apos;s secret.
          </p>
        </div>
        {!draft && <Button size="sm" onClick={() => { setMessage(null); setDraft({ ...BLANK }); }}>Add a webhook</Button>}
      </CardHeader>
      <CardContent className="space-y-4">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {draft && (
          <div className="space-y-3 rounded-md border p-4" data-webhook-form>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Name</span>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Accounting system" aria-label="Webhook name" />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Address</span>
                <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/hooks/crm" aria-label="Webhook address" />
              </label>
            </div>
            <fieldset className="text-sm">
              <legend className="mb-1.5 font-medium">Events</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {WEBHOOK_EVENTS.map((e) => (
                  <label key={e.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.events.includes(e.key)}
                      onChange={(ev) => setDraft({ ...draft, events: ev.target.checked ? [...draft.events, e.key] : draft.events.filter((k) => k !== e.key) })}
                    />
                    {e.label} <span className="font-mono text-xs text-muted-foreground">{e.key}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active
            </label>
            <div className="flex gap-2">
              <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save webhook"}</Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>Cancel</Button>
            </div>
          </div>
        )}

        {webhooks.length === 0 && !draft ? (
          <p className="text-sm text-muted-foreground">No webhooks yet.</p>
        ) : (
          <ul className="space-y-3">
            {webhooks.map((w) => (
              <li key={w.id} className="rounded-md border p-3 text-sm" data-webhook={w.name}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{w.name} {!w.active && <Badge tone="neutral">Off</Badge>}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{w.url}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{w.events.join(", ")}</p>
                    {w.lastDelivery && (
                      <p className="mt-1 text-xs text-muted-foreground">Last delivery {w.lastDelivery.status.toLowerCase()} · {formatDateTime(w.lastDelivery.at)}</p>
                    )}
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Signing secret</summary>
                      <code className="break-all">{w.secret}</code>
                    </details>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => sendTestWebhook(w.id), "A test is on its way. It shows in the log below within a minute.")}>Send a test</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft({ id: w.id, name: w.name, url: w.url, events: w.events, active: w.active })}>Edit</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => window.confirm("Make a new secret? The receiver must be given it, or it will reject our calls.") && act(() => rotateWebhookSecret(w.id), "New secret made.")}>New secret</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => window.confirm(`Remove "${w.name}"?`) && act(() => deleteWebhook(w.id), "Webhook removed.")}>Remove</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Try a failed delivery again. */
export function RetryButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await retryDelivery(id);
          if (!result.ok) return window.alert(result.error);
          softReload();
        })
      }
    >
      Retry
    </Button>
  );
}
