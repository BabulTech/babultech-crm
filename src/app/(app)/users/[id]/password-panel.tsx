"use client";

import { PasswordInput } from "@/components/password-input";
import { useState, useTransition } from "react";
import { setUserPassword } from "@/server/users";
import { sendPasswordLink } from "@/server/password-links";
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Alert } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

type LatestLink = { purpose: string; sentAt: string; expiresAt: string; usedAt: string | null; emailStatus: string | null } | null;

/** Administrator-side password reset: email them a link to choose a new one,
 *  or set one here. The current password is not required — an admin resetting
 *  an account is a different act from a user changing theirs. */
export function PasswordPanel({ userId, fullName, email, latestLink }: { userId: string; fullName: string; email: string; latestLink: LatestLink }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const firstName = fullName.split(" ")[0];

  function sendLink() {
    setError(null);
    setNotice(null);
    setLink(null);
    setCopied(false);
    startTransition(async () => {
      const result = await sendPasswordLink(userId);
      if (!result.ok) { setError(result.error); return; }
      if (result.data.emailedTo) {
        setNotice(`Reset link emailed to ${result.data.emailedTo}. It works once, for 24 hours.`);
      } else {
        setError(`The link was made but not emailed: ${result.data.emailError} Copy it below and send it to ${firstName} yourself.`);
        setLink(result.data.url);
      }
    });
  }

  function submit(formData: FormData) {
    setError(null);
    setNotice(null);
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }

    startTransition(async () => {
      const result = await setUserPassword(userId, password);
      if (result.ok) {
        setNotice(`Password set. Tell ${firstName} to sign in with it and change it.`);
        setOpen(false);
      } else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {link && (
          <div className="space-y-2">
            <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Reset link" />
            <Button type="button" size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Emails <span className="font-medium text-foreground">{email}</span> a link to choose a new password. It works once and lasts 24 hours; a new link replaces the last one.
        </p>
        <Button className="w-full" onClick={sendLink} disabled={pending}>
          {pending && !open ? "Sending…" : "Send password reset link"}
        </Button>
        {latestLink && (
          <p className="text-xs text-muted-foreground">
            Last link ({latestLink.purpose === "WELCOME" ? "welcome" : "reset"}): sent {formatDateTime(latestLink.sentAt)}
            {latestLink.emailStatus === "SENT" ? "" : latestLink.emailStatus ? ", email failed" : ", not emailed"}
            {" · "}
            {latestLink.usedAt
              ? `used ${formatDateTime(latestLink.usedAt)}`
              : Date.parse(latestLink.expiresAt) < Date.now()
                ? "expired unused"
                : `not used yet, open until ${formatDateTime(latestLink.expiresAt)}`}
          </p>
        )}

        {open ? (
          <form action={submit} className="space-y-3 border-t pt-3">
            <Field label="New password" hint="At least 10 characters, mixed case, with a number.">
              <PasswordInput name="password" required autoComplete="new-password" />
            </Field>
            <Field label="Confirm">
              <PasswordInput name="confirm" required autoComplete="new-password" />
            </Field>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Setting…" : "Set password"}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
            Set a password myself
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
