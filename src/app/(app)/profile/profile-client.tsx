"use client";

import { PasswordInput } from "@/components/password-input";
import { useState, useTransition } from "react";
import { changeOwnPassword } from "@/server/users";
import { Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Alert } from "@/components/ui";

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    setNotice(null);
    const current = String(formData.get("currentPassword") ?? "");
    const next = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirm") ?? "");

    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }

    startTransition(async () => {
      const result = await changeOwnPassword(current, next);
      if (result.ok) setNotice("Password changed.");
      else setError(result.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change your password</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={submit} className="max-w-sm space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}

          <Field label="Current password">
            <PasswordInput name="currentPassword" required autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters, mixed case, with a number.">
            <PasswordInput name="newPassword" required autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput name="confirm" required autoComplete="new-password" />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? "Changing…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
