"use client";
import { softReload } from "@/components/soft-navigation";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, Send, Check, X, Clock } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardContent, Input, Textarea, Button, Alert, Badge, Field,
} from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

export interface SentEmail {
  id: string;
  subject: string;
  toAddresses: unknown;
  status: string;
  sentReceivedAt: string;
  direction: string;
}

/**
 * Sending a document to the customer, and what has been sent before.
 *
 * The history matters as much as the form: "did anyone send this?" is the
 * question that gets asked when a customer says they never received it, and
 * failed sends are shown rather than hidden so the answer is honest.
 */
export function SendEmailPanel({
  documentLabel,
  defaultTo,
  defaultSubject,
  defaultMessage,
  configured,
  emails,
  send,
  blockedReason,
  reloadOnSend,
}: {
  documentLabel: string;
  defaultTo: string | null;
  defaultSubject: string;
  defaultMessage: string;
  configured: boolean;
  emails: SentEmail[];
  send: (input: {
    to: string;
    cc: string | null;
    subject: string;
    message: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Why this cannot be sent yet. Shown in place of the send button. */
  blockedReason?: string | null;
  /**
   * Reload the page after a send, so everything a send changes - the
   * document's status above all - is shown. router.refresh() can deliver a
   * page that is never displayed (the React 19.2 fault described in
   * components/deal-product-services.tsx).
   */
  reloadOnSend?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);

  function submit(formData: FormData) {
    setError(null);
    setSent(false);

    start(async () => {
      const result = await send({
        to: String(formData.get("to") ?? ""),
        cc: String(formData.get("cc") ?? "") || null,
        subject: String(formData.get("subject") ?? ""),
        message: String(formData.get("message") ?? ""),
      });

      if (result.ok) {
        setSent(true);
        setOpen(false);
        if (reloadOnSend) softReload();
        else router.refresh();
      } else {
        setError(result.error ?? "That did not send.");
      }
    });
  }

  const addressesOf = (value: unknown): string =>
    Array.isArray(value) ? value.join(", ") : String(value ?? "");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Send to customer
          {emails.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              ({emails.length} sent)
            </span>
          )}
        </CardTitle>
        {configured && !blockedReason && (
          <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : `Email ${documentLabel}`}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {!configured && (
          <Alert tone="info">
            Email is not configured on this deployment. Set <code>RESEND_API_KEY</code> and{" "}
            <code>EMAIL_FROM</code> to send from here - until then, download the record and send it
            yourself.
          </Alert>
        )}

        {configured && blockedReason && <Alert tone="info">{blockedReason}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {sent && <Alert tone="success">Sent.</Alert>}

        {open && configured && !blockedReason && (
          <form action={submit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="To" required>
                <Input
                  name="to"
                  type="email"
                  required
                  defaultValue={defaultTo ?? ""}
                  placeholder="customer@example.com"
                />
              </Field>
              <Field label="Cc">
                <Input name="cc" placeholder="Comma separated" />
              </Field>
            </div>

            <Field label="Subject" required>
              <Input name="subject" required defaultValue={defaultSubject} />
            </Field>

            <Field label="Message" required>
              <Textarea name="message" rows={6} required defaultValue={defaultMessage} />
            </Field>

            <p className="text-xs text-muted-foreground">
              The {documentLabel} number, dates and totals are appended automatically - you do not
              need to repeat them here.
            </p>

            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>
                <Send className="h-4 w-4" /> {pending ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        )}

        {emails.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing sent yet from here.
          </p>
        ) : (
          <ul className="divide-y">
            {emails.map((email) => (
              <li key={email.id} className="flex items-start gap-3 py-2.5">
                <span className="mt-0.5 shrink-0">
                  {email.status === "SENT" ? (
                    <Badge tone="success">
                      <Check className="h-3 w-3" /> Sent
                    </Badge>
                  ) : email.status === "FAILED" ? (
                    <Badge tone="danger">
                      <X className="h-3 w-3" /> Failed
                    </Badge>
                  ) : (
                    <Badge tone="neutral">
                      <Clock className="h-3 w-3" /> {email.status.toLowerCase()}
                    </Badge>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{email.subject}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {addressesOf(email.toAddresses)} · {formatDateTime(email.sentReceivedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
