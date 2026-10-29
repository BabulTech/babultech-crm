"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, Eye, EyeOff } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle,
  Field, Input, Select, Textarea, Table, THead, TBody, TR, TH, TD,
} from "@/components/ui";
import { sendMassEmail, type Recipient, type EmailTemplate, type EmailSender } from "@/server/communications";

type Audience = "Lead" | "Contact" | "CampaignMember" | "Prospect";

/**
 * Writing one email to many people - leads, contacts or campaign members.
 *
 * The audience is shown before the message, with anybody who will be left out
 * and why. A template or a blank page to start from; a sender address to send
 * as; a preview against a real recipient, so a placeholder with nothing behind
 * it is seen before it goes out.
 */
export function ComposeForm({
  audienceType,
  audience,
  templates,
  senders,
  defaultReplyTo,
  consentedOnly,
  consentHref,
}: {
  audienceType: Audience;
  audience: Recipient[];
  templates: EmailTemplate[];
  senders: EmailSender[];
  defaultReplyTo: string;
  consentedOnly: boolean;
  consentHref: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const defaultSender = senders.find((s) => s.isDefault) ?? senders[0] ?? null;
  const [senderId, setSenderId] = useState(defaultSender?.id ?? "");
  const sender = senders.find((s) => s.id === senderId) ?? null;
  const [fromName, setFromName] = useState(defaultSender?.fromName ?? "");
  const [replyTo, setReplyTo] = useState(defaultSender?.replyTo ?? defaultReplyTo);
  const [showAudience, setShowAudience] = useState(false);

  const sendable = audience.filter((a) => !a.skip);
  const skipped = audience.filter((a) => a.skip);
  const sample = sendable[0];

  const fill = useMemo(
    () => (text: string) =>
      text
        .replace(/\{\{\s*firstName\s*\}\}/g, sample?.firstName || "there")
        .replace(/\{\{\s*lastName\s*\}\}/g, sample?.lastName && sample.lastName !== "-" ? sample.lastName : "")
        .replace(/\{\{\s*companyName\s*\}\}/g, sample?.companyName ?? "your company")
        .replace(/\{\{\s*senderName\s*\}\}/g, fromName),
    [sample, fromName],
  );

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if ((subject || body) && !window.confirm("Replace what you have written with this template?")) return;
    setSubject(t.subject);
    setBody(t.body);
  }

  function chooseSender(id: string) {
    setSenderId(id);
    const s = senders.find((x) => x.id === id);
    if (s) {
      setFromName(s.fromName);
      if (s.replyTo) setReplyTo(s.replyTo);
    }
  }

  function send() {
    setError(null);
    const count = sendable.length;
    if (!window.confirm(`Send this to ${count} ${count === 1 ? "person" : "people"}?\n\nThis cannot be undone or recalled.`)) return;
    start(async () => {
      const result = await sendMassEmail({
        audience: audienceType,
        // Everyone chosen: the server works out again who is left out, and records why.
        ids: audience.map((a) => a.id),
        subject,
        bodyText: body,
        senderId: senderId || null,
        fromName,
        replyTo,
        templateId: templateId || null,
        consentedOnly,
      });
      if (!result.ok) return setError(result.error);
      router.push(`/leads/email/sends/${result.data.batchId}?queued=${result.data.queued}`);
    });
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Going to {sendable.length} {sendable.length === 1 ? "person" : "people"}</CardTitle>
            {skipped.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">{skipped.length} of the {audience.length} chosen will be left out.</p>
            )}
            {consentHref && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={consentedOnly} onChange={() => window.location.assign(consentHref)} />
                Only contacts who agreed to marketing
              </label>
            )}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowAudience(!showAudience)}>
            {showAudience ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showAudience ? "Hide the list" : "See who"}
          </Button>
        </CardHeader>
        {sendable.length === 0 && (
          <CardContent>
            <Alert tone="danger">Nobody here can be emailed: every one has no address, or has asked not to be contacted.</Alert>
          </CardContent>
        )}
        {showAudience && (
          <CardContent className="px-0">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH priority="secondary">Company</TH>
                  <TH>Email</TH>
                  <TH>Will get it?</TH>
                </TR>
              </THead>
              <TBody>
                {audience.map((a) => (
                  <TR key={a.id}>
                    <TD className="text-sm font-medium">{a.name}</TD>
                    <TD className="text-sm" priority="secondary">{a.companyName ?? "—"}</TD>
                    <TD className="text-sm">{a.email ?? "—"}</TD>
                    <TD>{a.skip ? <Badge tone="warning">{a.skip}</Badge> : <Badge tone="success">Yes</Badge>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The message</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Start from a template" help={templates.length ? "Fills in the subject and message; change them as you like." : "None yet - save one under Email templates."}>
            <Select value={templateId} onChange={(e) => applyTemplate(e.target.value)} disabled={!templates.length}>
              <option value="">A blank message</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Send as" help={sender ? `From ${sender.fromAddress}.` : "The system address."}>
            <Select value={senderId} onChange={(e) => chooseSender(e.target.value)}>
              {senders.length === 0 && <option value="">The system address</option>}
              {senders.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.fromAddress})</option>)}
            </Select>
          </Field>
          <Field label="From name" help="The name people see it from.">
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Reply to" help="Where replies land.">
            <Input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} maxLength={255} />
          </Field>
          <Field label="Subject" required>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} placeholder="A quick question about {{companyName}}" />
          </Field>
          <Field label="Placeholders" help="Each person gets their own details; an empty one falls back to something neutral.">
            <p className="text-sm text-muted-foreground">
              {["firstName", "lastName", "companyName", "senderName"].map((p) => (
                <code key={p} className="mr-1 rounded bg-muted px-1">{`{{${p}}}`}</code>
              ))}
            </p>
          </Field>
          <Field label="Message" required>
            <Textarea rows={12} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"Hello {{firstName}},\n\n…"} />
          </Field>
          <Field label="Preview" help={sample ? `As ${sample.name} will see it.` : "Nobody to preview against."}>
            <div className="min-h-[13rem] rounded-md border bg-muted/30 p-3 text-sm">
              {subject || body ? (
                <>
                  <p className="font-medium">{fill(subject) || "(no subject)"}</p>
                  <p className="mt-2 whitespace-pre-wrap">{fill(body)}</p>
                  <p className="mt-4 border-t pt-2 text-xs text-muted-foreground">You are receiving this because you are on our mailing list. Unsubscribe.</p>
                </>
              ) : (
                <p className="text-muted-foreground">Start typing, or choose a template.</p>
              )}
            </div>
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={send} disabled={pending || sendable.length === 0 || !subject.trim() || !body.trim()}>
          <Send className="h-4 w-4" />
          {pending ? "Sending…" : `Send to ${sendable.length} ${sendable.length === 1 ? "person" : "people"}`}
        </Button>
        <p className="text-sm text-muted-foreground">Every message carries an unsubscribe link. Sending cannot be undone.</p>
      </div>
    </div>
  );
}
