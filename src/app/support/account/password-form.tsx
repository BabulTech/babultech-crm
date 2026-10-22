"use client";

import { PasswordInput } from "@/components/password-input";
import { useState, useTransition } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { changeOwnPassword } from "@/server/users";

/** Changing the temporary password the portal invitation carried. */
export function PasswordForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    setError(null);
    setDone(false);

    const next = String(fd.get("newPassword") ?? "");
    if (next !== String(fd.get("confirm") ?? "")) {
      setError("The two new passwords do not match.");
      return;
    }

    start(async () => {
      const result = await changeOwnPassword(String(fd.get("currentPassword") ?? ""), next);
      if (result.ok) {
        setDone(true);
        form.reset();
      } else setError(result.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {done && <Alert tone="success">Your password has been changed. Use it next time you sign in.</Alert>}

      <Field label="Current password" required help="The one we emailed you, or the one you set last time.">
        <PasswordInput name="currentPassword" required autoComplete="current-password" />
      </Field>
      <Field label="New password" required>
        <PasswordInput name="newPassword" required autoComplete="new-password" />
      </Field>
      <Field label="New password again" required>
        <PasswordInput name="confirm" required autoComplete="new-password" />
      </Field>

      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Change password"}</Button>
    </form>
  );
}
