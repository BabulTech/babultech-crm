"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createSecret, updateSecret } from "@/server/secrets";
import {
  Button, Card, CardContent, CardHeader, CardTitle, Field, Input,
  Select, Textarea, Alert,
} from "@/components/ui";
import { RecordLookup } from "@/components/record-lookup";
import { humanize } from "@/lib/utils";
import { parseEnvFile } from "@/lib/env-file";

const KINDS = [
  "API_KEY", "PASSWORD", "EMAIL_ACCOUNT", "DATABASE", "CERTIFICATE",
  "SSH_KEY", "WEBHOOK_SECRET", "TOKEN", "ENV_FILE", "OTHER",
];
const kindLabel = (k: string) => (k === "ENV_FILE" ? "Environment file (.env)" : humanize(k));
const ENVIRONMENTS = ["PRODUCTION", "STAGING", "DEVELOPMENT", "SHARED"];
const STATUSES = ["ACTIVE", "ROTATING", "REVOKED"];

export interface SecretFormOptions {
  users: { id: string; fullName: string; jobTitle: string | null }[];
}

export interface SecretDefaults {
  id: string;
  name: string;
  service: string;
  kind: string;
  environment: string;
  status: string;
  username: string | null;
  url: string | null;
  ownerUserId: string;
  projectId: string | null;
  expiresAt: string | null;
  rotationDays: string | null;
  lastRotatedAt: string | null;
  storedIn: string | null;
  notes: string | null;
  valueHint: string | null;
}

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function SecretForm({
  options,
  defaults,
  currentUserId,
}: {
  options: SecretFormOptions;
  defaults?: SecretDefaults;
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  // Typed secrets are masked by default, so the value is not left on screen in
  // an office or a shared call while the rest of the form is filled in.
  const [showValue, setShowValue] = useState(false);
  const [kind, setKind] = useState(defaults?.kind ?? "API_KEY");
  const [envText, setEnvText] = useState("");
  const envFile = kind === "ENV_FILE";
  const parsedEnv = envFile && envText ? parseEnvFile(envText) : null;

  const editing = Boolean(defaults);

  // A submit HANDLER rather than <form action={...}>. React resets a form after
  // an action completes, and every field here is uncontrolled (defaultValue), so
  // with `action` a rejected submit cleared everything the user had typed and
  // made them fill the whole form in again to correct one field.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    setError(null);
    setFieldErrors({});

    const get = (k: string) => {
      const v = formData.get(k);
      return v === null || v === "" ? null : String(v);
    };

    const input = {
      name: String(formData.get("name") ?? ""),
      service: String(formData.get("service") ?? ""),
      kind: get("kind"),
      environment: get("environment"),
      status: get("status"),
      username: get("username"),
      url: get("url"),
      ownerUserId: String(formData.get("ownerUserId") ?? ""),
      projectId: get("projectId"),
      expiresAt: get("expiresAt"),
      rotationDays: get("rotationDays"),
      lastRotatedAt: get("lastRotatedAt"),
      storedIn: get("storedIn"),
      notes: get("notes"),
      value: get("value"),
    } as never;

    startTransition(async () => {
      const result = defaults
        ? await updateSecret(defaults.id, input)
        : await createSecret(input);

      if (result.ok) {
        // A full load: router.push did not take effect on the live build.
        window.location.assign(`/vault/${result.data.id}`);
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>What this is</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={fieldErrors.name?.[0]}
            help="What people call it. Specific enough to tell two keys for the same service apart.">
            <Input
              name="name"
              required
              defaultValue={defaults?.name}
              placeholder={envFile ? "BabulPos production .env" : "Stripe live secret key"}
            />
          </Field>
          <Field label="Project"
            help="The project this belongs to. Leave it empty for company-wide credentials, which are filed under BabulTech Internal.">
            <RecordLookup entity="project" name="projectId" defaultValue={defaults?.projectId ?? null}
              emptyLabel="BabulTech Internal" placeholder="Search projects… (empty = BabulTech Internal)" />
          </Field>
          <Field label="Service" required error={fieldErrors.service?.[0]}
            help="The system it belongs to. A key with no service attached is unidentifiable six months later.">
            <Input
              name="service"
              required
              defaultValue={defaults?.service}
              placeholder="Stripe"
            />
          </Field>
          <Field label="Kind" required
            help="What sort of credential it is. Only used for grouping and filtering.">
            <Select name="kind" required value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{kindLabel(k)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Environment" required
            help="Which environment it belongs to. Production keys are the ones worth being careful with.">
            <Select name="environment" required defaultValue={defaults?.environment ?? "PRODUCTION"}>
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>{humanize(e)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Username or account"
            help="The login this goes with, where there is one. Leave empty for a bare API key.">
            <Input
              name="username"
              defaultValue={defaults?.username ?? ""}
              placeholder="billing@babultech.com"
            />
          </Field>
          <Field label="Login URL"
            help="Where you go to use or regenerate this, so nobody has to hunt for the dashboard.">
            <Input
              name="url"
              defaultValue={defaults?.url ?? ""}
              placeholder="https://dashboard.stripe.com/apikeys"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The secret</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label={editing ? "Replace the value" : "Value"}
            required={!editing}
            error={fieldErrors.value?.[0]}
            hint={
              editing
                ? `Leave empty to keep the current value${defaults?.valueHint ? ` (ends ${defaults.valueHint})` : ""}.`
                : undefined
            }
            help="Encrypted before it is stored. It can only be read back through Reveal, and every reveal is recorded against your name."
          >
            {envFile ? (
              <div className="space-y-2">
                <Textarea
                  name="value"
                  rows={14}
                  required={!editing}
                  spellCheck={false}
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  className="font-mono text-xs"
                  placeholder={editing ? "Unchanged. Paste the whole new file to replace it." : "Paste the whole .env file\nDATABASE_URL=postgres://…\nRESEND_API_KEY=re_…"}
                />
                {parsedEnv && (
                  <p className={parsedEnv.invalidLines.length ? "text-xs text-amber-700 dark:text-amber-400" : "text-xs text-muted-foreground"}>
                    {parsedEnv.variables.length} variable{parsedEnv.variables.length === 1 ? "" : "s"} found
                    {parsedEnv.invalidLines.length > 0 && ` · line${parsedEnv.invalidLines.length === 1 ? "" : "s"} ${parsedEnv.invalidLines.slice(0, 8).join(", ")} ${parsedEnv.invalidLines.length === 1 ? "is" : "are"} not NAME=value (kept as written)`}
                  </p>
                )}
              </div>
            ) : (
            <div className="flex gap-2">
              <Input
                name="value"
                type={showValue ? "text" : "password"}
                required={!editing}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={editing ? "Unchanged" : "Paste the key or password"}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowValue((v) => !v)}
                aria-label={showValue ? "Hide the value" : "Show the value"}
              >
                {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            )}
          </Field>

          {editing && (
            <Alert tone="info">
              Entering a new value here counts as a rotation - the last rotated
              date is set to today, and the change is recorded in this
              secret&apos;s history.
            </Alert>
          )}

          <Field label="Where the live copy lives"
            help="Where the running system actually reads this from. This is what someone needs during an incident, and it is the question the vault exists to answer.">
            <Input
              name="storedIn"
              defaultValue={defaults?.storedIn ?? ""}
              placeholder="Vercel env var STRIPE_SECRET_KEY"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ownership and lifetime</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Owner" required error={fieldErrors.ownerUserId?.[0]}
            help="Who is accountable for renewing and revoking it - not necessarily whoever typed it in here.">
            <RecordLookup entity="user" name="ownerUserId" defaultValue={defaults?.ownerUserId ?? currentUserId} required />
          </Field>
          <Field label="Status" required
            help="Revoked means it has been turned off at the provider. The record stays so the access log still points at something.">
            <Select name="status" required defaultValue={defaults?.status ?? "ACTIVE"}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{humanize(s)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Expires on" hint="Leave empty if it does not expire."
            help="The provider's own deadline. Empty means no known expiry, which is not the same as never checking it again.">
            <Input
              name="expiresAt"
              type="date"
              defaultValue={dateInput(defaults?.expiresAt ?? null)}
            />
          </Field>
          <Field label="Rotate every (days)" hint="Leave empty if you do not rotate it."
            help="Our own policy, separate from the provider's expiry. A key can be valid and still overdue a change."
            error={fieldErrors.rotationDays?.[0]}>
            <Input
              name="rotationDays"
              type="number"
              min="1"
              step="1"
              defaultValue={defaults?.rotationDays ?? ""}
              placeholder="90"
            />
          </Field>
          <Field label="Last rotated"
            help="Set automatically whenever you replace the value above. Fill it in by hand only for a rotation that happened before this was recorded here.">
            <Input
              name="lastRotatedAt"
              type="date"
              defaultValue={dateInput(defaults?.lastRotatedAt ?? null)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            name="notes"
            rows={4}
            defaultValue={defaults?.notes ?? ""}
            placeholder="What it is used for, what breaks without it, and anything the next person needs to know before changing it."
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Add to the vault"}
        </Button>
      </div>
    </form>
  );
}
