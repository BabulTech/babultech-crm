"use client";
import { softReload } from "@/components/soft-navigation";

import { useTransition } from "react";
import { MailX, MailCheck } from "lucide-react";
import { Button } from "@/components/ui";
import { setContactEmailOptOut } from "@/server/communications";

/**
 * Whether a contact is happy to be emailed. Opting out suppresses the address
 * for every send, including them as a lead or a campaign member.
 */
export function EmailOptOutButton({ contactId, optedOut }: { contactId: string; optedOut: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      title={optedOut ? "They asked not to be emailed. Click if they have asked to hear from us again." : "Record that they do not want marketing email."}
      onClick={() => {
        if (!optedOut && !window.confirm("Stop all marketing email to this person's address?")) return;
        start(async () => {
          const result = await setContactEmailOptOut(contactId, !optedOut);
          if (!result.ok) return window.alert(result.error);
          // A full reload: see log-touch-button.tsx.
          softReload();
        });
      }}
    >
      {optedOut ? <MailX className="h-4 w-4" /> : <MailCheck className="h-4 w-4" />}
      {optedOut ? "Opted out of email" : "Opt out of email"}
    </Button>
  );
}
