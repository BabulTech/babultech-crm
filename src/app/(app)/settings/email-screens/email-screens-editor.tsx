"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Select } from "@/components/ui";
import { saveEmailScreenSetting, type listEmailScreenSettings } from "@/server/email-anywhere";

type Data = Awaited<ReturnType<typeof listEmailScreenSettings>>;
type Screen = Data["screens"][number];

function ScreenCard({ screen, roles, senders, templates }: { screen: Screen } & Omit<Data, "screens">) {
  const [s, setS] = useState(screen);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const save = () => start(async () => {
    const r = await saveEmailScreenSetting(s);
    setMsg(r.ok ? { tone: "success", text: "Saved." } : { tone: "danger", text: r.error });
  });
  return (
    <Card data-screen={s.entityType}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{s.label}</CardTitle>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label={`Email on ${s.label}`} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          {s.enabled ? "On" : "Off"}
        </label>
      </CardHeader>
      <CardContent className="space-y-3">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div>
          <p className="mb-1 text-sm font-medium">Roles that may send</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={s.roleIds.includes(r.id)} disabled={!s.enabled}
                  onChange={(e) => setS({ ...s, roleIds: e.target.checked ? [...s.roleIds, r.id] : s.roleIds.filter((x) => x !== r.id) })} />
                {r.name}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default sender">
            <Select value={s.defaultSenderId ?? ""} disabled={!s.enabled} onChange={(e) => setS({ ...s, defaultSenderId: e.target.value || null })}>
              <option value="">The company default</option>
              {senders.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.fromAddress})</option>)}
            </Select>
          </Field>
          <Field label="Default template">
            <Select value={s.defaultTemplateId ?? ""} disabled={!s.enabled} onChange={(e) => setS({ ...s, defaultTemplateId: e.target.value || null })}>
              <option value="">None</option>
              {templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        </div>
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </CardContent>
    </Card>
  );
}

export function EmailScreensEditor({ screens, ...rest }: Data) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {screens.map((s) => <ScreenCard key={s.entityType} screen={s} {...rest} />)}
    </div>
  );
}
