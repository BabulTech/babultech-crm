"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { PasswordInput } from "@/components/password-input";
import { DashboardSkeleton } from "@/components/page-skeleton";

/**
 * The sign-in form.
 *
 * The action only signs in and says where to go; the navigation happens here.
 * When the action redirected itself, the browser kept showing this form,
 * unchanged, until the whole first page had rendered on the server - a second
 * or more with nothing to say the click had worked. Now the button shows
 * progress while the password is checked, and the moment it is accepted the
 * screen becomes the app's skeleton while the first page loads behind it.
 */
export function LoginForm({ action }: { action: (formData: FormData) => Promise<{ start: string }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [entering, setEntering] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    start(async () => {
      // A refused sign-in redirects back here with ?error, from inside the action.
      const result = await action(formData);
      setEntering(true);
      router.replace(result.start);
    });
  }

  if (entering) return <EnteringApp />;

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email" required>
        <Input name="email" type="email" autoComplete="email" required placeholder="you@babultech.com" />
      </Field>
      <Field label="Password" required>
        <PasswordInput required />
      </Field>
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}

/** The app's frame - sidebar and a dashboard-shaped page - shown over everything until it arrives. */
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
