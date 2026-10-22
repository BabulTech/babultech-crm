"use client";

import { PasswordInput } from "@/components/password-input";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select,
} from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import {
  grantPortalAccess, revokePortalAccess, setPortalScope, resetPortalPassword,
  type PortalAccess,
} from "@/server/customer-access";

/**
 * Whether this contact may sign in to the customer portal.
 *
 * Lives on the contact rather than on the Users screen: the person deciding is
 * whoever owns the customer relationship, and they are already here. A customer
 * login is not an employee account and does not belong in the staff list.
 */
export function PortalAccessPanel({
  contactId,
  contactEmail,
  access,
  canManage,
}: {
  contactId: string;
  contactEmail: string | null;
  access: PortalAccess | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [resetting, setResetting] = useState(false);

  function onGrant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await grantPortalAccess({
        contactId,
        password: String(fd.get("password") ?? ""),
        portalScope: String(fd.get("portalScope") ?? "ACCOUNT") as "OWN" | "ACCOUNT",
      });
      if (result.ok) {
        setGranting(false);
        setNotice(
          result.data.emailed
            ? `${result.data.email} can now sign in. We have emailed them the password.`
            : `${result.data.email} can now sign in, but the email did not go out (${result.data.emailError ?? "unknown reason"}). Send them the password yourself - it is not shown again.`,
        );
        router.refresh();
      } else setError(result.error);
    });
  }

  function onReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await resetPortalPassword({ contactId, password: String(fd.get("password") ?? "") });
      if (result.ok) {
        setResetting(false);
        setNotice(
          result.data.emailed
            ? `A new password has been emailed to ${result.data.email}.`
            : `The password was changed, but the email did not go out (${result.data.emailError ?? "unknown reason"}). Send it to them yourself.`,
        );
        router.refresh();
      } else setError(result.error);
    });
  }

  function onRevoke() {
    if (!window.confirm("Remove portal access? Their tickets and history are kept.")) return;
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await revokePortalAccess(contactId);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  function onScope(portalScope: "OWN" | "ACCOUNT") {
    setError(null);
    start(async () => {
      const result = await setPortalScope(contactId, portalScope);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Portal access
        </CardTitle>
        {access && <Badge tone="success">Can sign in</Badge>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {access ? (
          <>
            <p className="text-muted-foreground">
              Signs in as <span className="font-medium text-foreground">{access.email}</span>
              {access.lastLoginAt
                ? ` · last signed in ${formatDateTime(access.lastLoginAt)}`
                : " · has not signed in yet"}
            </p>

            <Field label="Which tickets they see" help="Their own, or every ticket raised by their company.">
              <Select
                value={access.portalScope}
                disabled={!canManage || pending}
                onChange={(e) => onScope(e.target.value as "OWN" | "ACCOUNT")}
              >
                <option value="ACCOUNT">All of their company&apos;s tickets</option>
                <option value="OWN">Only the tickets they raised</option>
              </Select>
            </Field>

            {canManage && (resetting ? (
              <form onSubmit={onReset} className="space-y-3 rounded-md border border-dashed p-3">
                <Field label="New password" required help="At least 12 characters. We email it to them.">
                  <PasswordInput name="password" minLength={12} required autoComplete="new-password" />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Set and email it"}</Button>
                  <Button type="button" variant="ghost" onClick={() => setResetting(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => { setResetting(true); setError(null); setNotice(null); }} disabled={pending}>
                  <KeyRound className="h-4 w-4" /> Send a new password
                </Button>
                <Button variant="outline" onClick={onRevoke} disabled={pending} className="text-destructive hover:text-destructive">
                  Remove access
                </Button>
              </div>
            ))}
          </>
        ) : granting ? (
          <form onSubmit={onGrant} className="space-y-3">
            <p className="text-muted-foreground">
              They will sign in with <span className="font-medium text-foreground">{contactEmail}</span>.
            </p>
            <Field label="Temporary password" required help="At least 12 characters. We email it to them; it is not shown again here.">
              <PasswordInput name="password" minLength={12} required autoComplete="new-password" placeholder="e.g. autumn-kettle-97-rain" />
            </Field>
            <Field label="Which tickets they see">
              <Select name="portalScope" defaultValue="ACCOUNT">
                <option value="ACCOUNT">All of their company&apos;s tickets</option>
                <option value="OWN">Only the tickets they raise</option>
              </Select>
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Give access"}</Button>
              <Button type="button" variant="ghost" onClick={() => setGranting(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-muted-foreground">
              They cannot sign in. Give them access and they can raise tickets, follow them and read
              the help articles.
            </p>
            {canManage && (
              <Button
                variant="outline"
                disabled={!contactEmail}
                title={contactEmail ? undefined : "Add an email address first."}
                onClick={() => { setGranting(true); setError(null); setNotice(null); }}
              >
                <KeyRound className="h-4 w-4" /> Give portal access
              </Button>
            )}
            {!contactEmail && (
              <p className="text-xs text-muted-foreground">
                Add an email address to this contact first - it is what they sign in with.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
