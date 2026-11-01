"use client";

import { useState, useTransition } from "react";
import { Alert, Button } from "@/components/ui";
import { softReload } from "@/components/soft-navigation";
import { retryFailedEmails } from "@/server/activity-log";

/** Admins only: portal email is failing, and nobody would otherwise notice. */
export function EmailHealthBanner({ health }: { health: { failing: boolean; failures: number; error: string | null } }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  if (!health.failing) return null;

  function retry() {
    start(async () => {
      const result = await retryFailedEmails();
      setMessage(result.ok ? `${result.data.count} queued. They go out within a minute or two.` : result.error);
      softReload();
    });
  }

  return (
    <div className="mb-4" data-testid="email-health-banner">
      <Alert tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <strong>Portal email is failing.</strong> {health.failures} {health.failures === 1 ? "attempt has" : "attempts have"} failed since the last successful send.
            {health.error ? ` Latest error: ${health.error}` : ""} {message}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={retry}>{pending ? "Queuing…" : "Retry failed emails"}</Button>
        </div>
      </Alert>
    </div>
  );
}
