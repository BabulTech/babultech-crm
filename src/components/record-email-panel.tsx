"use client";

import { useRef, useState, useTransition } from "react";
import { Mail, Paperclip, Plus, Send, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { RichTextEditor } from "@/components/rich-text-editor";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { formatDateTime } from "@/lib/utils";
import { EMAIL_ATTACHMENT_LIMIT, EMAIL_PLACEHOLDERS, fillEmailPlaceholders } from "@/lib/email-screens";
import { prepareEmailUpload, sendRecordEmail, type getEmailComposeContext, type listRecordEmails } from "@/server/email-anywhere";

type Context = NonNullable<Awaited<ReturnType<typeof getEmailComposeContext>>>;
type SentEmail = Awaited<ReturnType<typeof listRecordEmails>>[number];
type Upload = { path: string; fileName: string; mimeType: string | null; size: number };

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const split = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** A list of addresses typed or picked, shown as removable chips. */
function AddressField({ label, values, onChange, suggestions, required }: {
  label: string; values: string[]; onChange: (v: string[]) => void; suggestions?: { email: string; label: string; optedOut?: boolean }[]; required?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const next = [...values];
    for (const a of split(raw)) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
    onChange(next);
    setDraft("");
  };
  return (
    <Field label={label} required={required}>
      <div className="flex flex-wrap items-center gap-1 rounded-md border px-2 py-1">
        {values.map((v) => (
          <Badge key={v} tone="neutral">
            {v}
            <button type="button" className="ml-1 opacity-60 hover:opacity-100" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X className="h-3 w-3" /></button>
          </Badge>
        ))}
        <input
          aria-label={label}
          className="min-w-[160px] flex-1 bg-transparent py-1 text-sm outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === "," || e.key === "Tab") && draft.trim()) { e.preventDefault(); add(draft); } }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={values.length ? "" : "name@company.com"}
        />
      </div>
      {suggestions && suggestions.some((s) => !values.includes(s.email)) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {suggestions.filter((s) => !values.includes(s.email)).map((s) => (
            <button key={s.email} type="button" disabled={s.optedOut} title={s.optedOut ? "Asked not to be emailed" : undefined}
              onClick={() => add(s.email)} className="rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:line-through disabled:opacity-50">
              <Plus className="mr-0.5 inline h-3 w-3" />{s.label ? `${s.label} · ` : ""}{s.email}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

function Composer({ c, onClose }: { c: Context; onClose: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [senderId, setSenderId] = useState(c.defaultSenderId ?? "");
  const sender = c.senders.find((s) => s.id === senderId);
  const [replyTo, setReplyTo] = useState(c.myEmail);
  const [to, setTo] = useState<string[]>(c.suggestions[0] && !c.suggestions[0].optedOut ? [c.suggestions[0].email] : []);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const startTemplate = c.templates.find((t) => t.id === c.defaultTemplateId);
  const [subject, setSubject] = useState(startTemplate ? fillEmailPlaceholders(startTemplate.subject, c.values, false) : "");
  const [body, setBody] = useState({ key: 0, html: startTemplate?.body ?? "" });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const total = uploads.reduce((s, u) => s + u.size, 0) + c.documents.filter((d) => docIds.includes(d.id)).reduce((s, d) => s + Number(d.fileSizeBytes ?? 0), 0);

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setUploading(true);
    try {
      let size = total;
      for (const file of Array.from(files)) {
        if (size + file.size > EMAIL_ATTACHMENT_LIMIT) { setError("Attachments can come to 10 MB at most."); break; }
        const link = await prepareEmailUpload(c.entityType, c.entityId, file.name, file.size);
        if (!link.ok) { setError(link.error); break; }
        const { error: upErr } = await supabaseBrowser().storage.from("documents").uploadToSignedUrl(link.data.path, link.data.token, file, { contentType: file.type || "application/octet-stream" });
        if (upErr) { setError(`${file.name} could not be uploaded: ${upErr.message}`); break; }
        size += file.size;
        setUploads((u) => [...u, { path: link.data.path, fileName: file.name, mimeType: file.type || null, size: file.size }]);
      }
    } finally {
      setUploading(false);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const html = String(new FormData(formRef.current!).get("body") ?? "");
    start(async () => {
      const r = await sendRecordEmail({ entityType: c.entityType, entityId: c.entityId, senderId, replyTo, to, cc, bcc, subject, bodyHtml: html, uploads, documentIds: docIds });
      if (!r.ok) { setError(r.error); return; }
      setDone(r.data.note ?? `Sent to ${to.join(", ")}.`);
    });
  }

  if (done) {
    return (
      <div className="space-y-3">
        <Alert tone="success">{done}</Alert>
        <Button onClick={() => window.location.reload()}>Done</Button>
      </div>
    );
  }

  if (!c.senders.length) {
    return <Alert tone="warning">No sender addresses are set up yet. An administrator adds them under Admin, Sender addresses.</Alert>;
  }

  return (
    <form ref={formRef} onSubmit={send} className="space-y-3 rounded-md border bg-muted/20 p-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" required help="Only approved sender addresses can be used: the mail service sends from your company's verified domain only.">
          <Select aria-label="From" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
            {c.senders.map((s) => <option key={s.id} value={s.id}>{s.fromName ? `${s.fromName} <${s.fromAddress}>` : s.fromAddress}</option>)}
          </Select>
        </Field>
        <Field label="Reply-to" help="Where replies go. Your own address unless you change it.">
          <Input aria-label="Reply-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={sender?.replyTo ?? c.myEmail} />
        </Field>
      </div>
      <AddressField label="To" values={to} onChange={setTo} suggestions={c.suggestions} required />
      {showCopies ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <AddressField label="CC" values={cc} onChange={setCc} />
          <AddressField label="BCC" values={bcc} onChange={setBcc} />
        </div>
      ) : (
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowCopies(true)}>Add CC or BCC</button>
      )}
      {c.templates.length > 0 && (
        <Field label="Start from a template">
          <Select aria-label="Template" defaultValue={startTemplate?.id ?? ""} onChange={(e) => {
            const t = c.templates.find((x) => x.id === e.target.value);
            if (!t) return;
            setSubject(fillEmailPlaceholders(t.subject, c.values, false));
            setBody((b) => ({ key: b.key + 1, html: t.body }));
          }}>
            <option value="">None</option>
            {c.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Subject" required>
        <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} required />
      </Field>
      <Field label="Message" required help={`You can write ${EMAIL_PLACEHOLDERS.map((p) => `{${p.name}}`).join(", ")}; they are filled in when the email is sent.`}>
        <RichTextEditor key={body.key} name="body" defaultValue={body.html} rows={8} />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium">Attachments <span className="text-xs font-normal text-muted-foreground">({kb(total)} of 10 MB)</span></p>
        {uploads.map((u) => (
          <div key={u.path} className="flex items-center gap-2 text-sm">
            <Paperclip className="h-3.5 w-3.5" /> {u.fileName} <span className="text-xs text-muted-foreground">{kb(u.size)}</span>
            <button type="button" aria-label={`Remove ${u.fileName}`} className="text-muted-foreground hover:text-foreground" onClick={() => setUploads((x) => x.filter((y) => y.path !== u.path))}><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          <Paperclip className="h-4 w-4" /> {uploading ? "Uploading…" : "Attach files"}
          <input type="file" multiple className="sr-only" aria-label="Attach files" disabled={uploading} onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
        </label>
        {c.documents.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Or attach a file already on this record:</p>
            {c.documents.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={docIds.includes(d.id)} onChange={(e) => setDocIds((x) => (e.target.checked ? [...x, d.id] : x.filter((y) => y !== d.id)))} />
                {d.fileName} <span className="text-xs text-muted-foreground">{kb(Number(d.fileSizeBytes ?? 0))}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || uploading || !to.length}><Send className="h-4 w-4" /> {pending ? "Sending…" : "Send"}</Button>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

export function EmailPanel({ context, emails }: { context: Context | null; emails: SentEmail[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2"><Mail className="h-4 w-4" /> Emails</CardTitle>
        {context && !open && <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New email</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {context && open && <Composer c={context} onClose={() => setOpen(false)} />}
        {emails.length === 0 ? (
          !open && <p className="text-sm text-muted-foreground">No emails sent from here yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {emails.map((e) => (
              <li key={e.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.subject}</span>
                  {e.status !== "SENT" && <Badge tone={e.status === "FAILED" ? "danger" : "neutral"}>{e.status === "FAILED" ? "Not sent" : e.status.toLowerCase()}</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  To {e.to.join(", ")}{e.cc.length ? `, cc ${e.cc.join(", ")}` : ""} · {e.sender ?? e.from} · {formatDateTime(e.at)}
                </p>
                {e.attachments.length > 0 && <p className="text-xs text-muted-foreground"><Paperclip className="mr-1 inline h-3 w-3" />{e.attachments.map((a) => a.fileName).join(", ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
