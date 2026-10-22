"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { PasswordInput } from "@/components/password-input";
import { DashboardSkeleton } from "@/components/page-skeleton";

const MESSAGES: Record<string, string> = {
  inactive: "That account is not active. Contact an administrator.",
};
const DEFAULT_MESSAGE = "That email and password combination did not work.";

/**
 * The sign-in form.
 *
 * Signing in is one round trip: the action checks the password and, when it is
 * accepted, redirects with the first page in the same response. That takes a
 * second or so, and the form used to sit unchanged the whole time. So the
 * screen becomes the app's skeleton the moment the button is pressed, and goes
 * back to the form, with the reason, only if the sign-in is refused - which is
 * the rare case.
 */
export function LoginForm({
  action,
  initialError,
}: {
  action: (formData: FormData) => Promise<{ error: string }>;
  initialError: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState(initialError);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    start(async () => {
      // Resolves only on a refusal; success redirects from inside the action.
      const result = await action(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <>
      {pending && <EnteringApp />}
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{MESSAGES[error] ?? DEFAULT_MESSAGE}</Alert>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" required>
          <Input name="email" type="email" autoComplete="email" required placeholder="you@babultech.com" />
        </Field>
        <Field label="Password" required>
          <PasswordInput required />
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          Sign in
        </Button>
      </form>
    </>
  );
}

/**
 * The app's frame - sidebar and a dashboard-shaped page - laid over the form
 * while signing in. The form stays mounted underneath, so a refusal simply
 * lifts this off and the email is still filled in.
 */
function EnteringApp() {
  return (
    <div className="fixed inset-0 z-50 flex bg-background" aria-busy="true" aria-live="polite">
      <span className="sr-only">Signing you in…</span>
      <aside className="hidden w-60 shrink-0 flex-col gap-2 border-r bg-card p-4 lg:flex">
        <div className="skeleton mb-4 h-8 w-32 rounded" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="skeleton h-6 rounded opacity-60" />
        ))}
      </aside>
      <main className="flex-1 overflow-hidden p-4 sm:p-6">
        <DashboardSkeleton />
      </main>
    </div>
  );
}
