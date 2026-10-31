"use client";
import { softReload } from "@/components/soft-navigation";

import { useRef, useState, useTransition } from "react";
import { ChevronDown, Copy, Check } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input } from "@/components/ui";
import { RichTextEditor } from "@/components/rich-text-editor";
import { formatDateTime, cn } from "@/lib/utils";
import { previewEmailTemplate, resetEmailTemplate, saveEmailTemplate, sendEmailTemplateTest } from "@/server/email-templates";
import type { SystemEmailKey } from "@/lib/system-emails";

interface Template {
  key: SystemEmailKey;
  name: string;
  sentWhen: string;
  placeholders: { name: string; meaning: string }[];
  subject: string;
  body: string;
  customised: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** One system email: its subject and message, with preview, test and reset. */
export function TemplateEditor({ template }: { template: Template }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  /** What is in the editor right now. */
  function current() {
    const data = new FormData(formRef.current!);
    return { subject: String(data.get("subject") ?? ""), body: String(data.get("body") ?? "") };
  }

  function run(action: () => Promise<void>) {
    setError(null);
    setNotice(null);
    start(action);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    run(async () => {
      const result = await saveEmailTemplate({ key: template.key, ...current() });
      if (result.ok) softReload();
      else setError(result.error);
    });
  }

  function reset() {
    if (!window.confirm(`Put "${template.name}" back to the built-in wording? Your changes to it are discarded.`)) return;
    run(async () => {
      const result = await resetEmailTemplate(template.key);
      if (result.ok) softReload();
      else setError(result.error);
    });
  }

  function showPreview() {
    run(async () => {
      const { subject, body } = current();
      const result = await previewEmailTemplate(template.key, subject, body);
      if (result.ok) setPreview(result.data);
      else setError(result.error);
    });
  }

  function sendTest() {
    run(async () => {
      const { subject, body } = current();
      const result = await sendEmailTemplateTest(template.key, subject, body);
      if (result.ok) setNotice(`Test sent to ${result.data.to}, with sample values.`);
      else setError(result.error);
    });
  }

  async function copyPlaceholder(name: string) {
    try {
      await navigator.clipboard.writeText(`{${name}}`);
      setCopied(name);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* The placeholder is on screen to type instead. */
    }
  }

  return (
    <Card>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start justify-between gap-3 p-5 text-left">
        <span>
          <span className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {template.name}
            {template.customised ? <Badge tone="info">Edited</Badge> : <Badge tone="neutral">Default</Badge>}
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">{template.sentWhen}</span>
          {template.customised && template.updatedAt && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Last edited {formatDateTime(template.updatedAt)}{template.updatedBy ? ` by ${template.updatedBy}` : ""}
            </span>
          )}
        </span>
        <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <form ref={formRef} onSubmit={save} className="space-y-4 border-t p-5">
          {error && <Alert tone="danger">{error}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}

          <Field label="Subject" required>
            <Input name="subject" defaultValue={template.subject} required maxLength={300} />
          </Field>
          <Field label="Message" required help="Bold, italics, lists and links are kept. The button and the details box are added below your message.">
            <RichTextEditor name="body" defaultValue={template.body} rows={8} />
          </Field>

          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <p className="mb-2 font-medium">Placeholders, filled in when the email is sent. Click one to copy it, then paste it where you want it.</p>
            <div className="flex flex-wrap gap-2">
              {template.placeholders.map((p) => (
                <button key={p.name} type="button" onClick={() => copyPlaceholder(p.name)} title={p.meaning}
                  className="inline-flex items-center gap-1 rounded border bg-card px-2 py-1 font-mono hover:bg-muted">
                  {copied === p.name ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {`{${p.name}}`}
                  <span className="font-sans text-muted-foreground">{p.meaning}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Working…" : "Save"}</Button>
            <Button type="button" variant="outline" onClick={showPreview} disabled={pending}>Preview</Button>
            <Button type="button" variant="outline" onClick={sendTest} disabled={pending}>Send test to me</Button>
            {template.customised && (
              <Button type="button" variant="ghost" onClick={reset} disabled={pending}>Reset to default</Button>
            )}
          </div>

          {preview && (
            <div className="space-y-2">
              <p className="text-sm"><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{preview.subject}</span></p>
              <iframe title={`Preview of ${template.name}`} srcDoc={preview.html} sandbox="" className="h-[560px] w-full rounded border bg-white" />
            </div>
          )}
        </form>
      )}
    </Card>
  );
}
