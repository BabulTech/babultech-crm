"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from "@/components/ui";
import { FormDialog } from "@/components/form-dialog";
import { saveTemplate, deleteTemplate, type EmailTemplate } from "@/server/communications";

const AUDIENCE_LABEL: Record<string, string> = {
  ANY: "Anyone",
  Lead: "Leads",
  Contact: "Contacts",
  CampaignMember: "Campaign members",
  Prospect: "Prospects",
};

type Draft = { id: string | null; name: string; audience: string; subject: string; body: string; active: boolean };
const BLANK: Draft = { id: null, name: "", audience: "ANY", subject: "", body: "", active: true };

export function TemplatesEditor({ templates, canAdd, isAdmin }: { templates: EmailTemplate[]; canAdd: boolean; isAdmin: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      if (!draft) return;
      setError(null);
      const result = await saveTemplate({ ...draft, audience: draft.audience as never });
      if (!result.ok) return setError(result.error);
      setDraft(null);
      router.refresh();
    });

  return (
    <>
      {canAdd && (
        <div className="mb-4">
          <Button onClick={() => { setError(null); setDraft({ ...BLANK }); }}>New template</Button>
        </div>
      )}
      <Card>
        {templates.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No templates yet" description="Save the emails you send often, such as a webinar invitation or a follow-up after a demo." />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Template</TH>
                <TH priority="secondary">For</TH>
                <TH priority="secondary">By</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {templates.map((t) => (
                <TR key={t.id}>
                  <TD className="text-sm">
                    <span className="font-medium">{t.name}</span> {!t.active && <Badge tone="neutral">Off</Badge>}
                    <p className="text-xs text-muted-foreground">{t.subject}</p>
                  </TD>
                  <TD className="text-sm" priority="secondary">{AUDIENCE_LABEL[t.audience] ?? t.audience}</TD>
                  <TD className="text-sm" priority="secondary">{t.createdByName ?? "—"}</TD>
                  <TD className="text-right">
                    {(t.mine || isAdmin) && (
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setError(null); setDraft({ id: t.id, name: t.name, audience: t.audience, subject: t.subject, body: t.body, active: t.active }); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => {
                            if (!window.confirm(`Delete the template "${t.name}"?`)) return;
                            start(async () => {
                              const result = await deleteTemplate(t.id);
                              if (!result.ok) window.alert(result.error);
                              router.refresh();
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <FormDialog open={Boolean(draft)} onOpenChange={(v) => !v && setDraft(null)} title={draft?.id ? "Edit template" : "New template"}>
        {draft && (
          <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={150} placeholder="Webinar invitation" />
              </Field>
              <Field label="For">
                <Select value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
                  {Object.entries(AUDIENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Subject" required>
              <Input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} maxLength={300} />
            </Field>
            <Field label="Message" required help="Placeholders: {{firstName}} {{lastName}} {{companyName}} {{senderName}}">
              <Textarea rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} maxLength={20000} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              Offered when composing
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
              <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save template"}</Button>
            </div>
          </div>
        )}
      </FormDialog>
    </>
  );
}
