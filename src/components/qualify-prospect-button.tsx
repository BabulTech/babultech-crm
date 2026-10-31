"use client";
import { softReload } from "@/components/soft-navigation";

import { useTransition } from "react";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui";
import { qualifyProspect } from "@/server/marketing";

/** Moves a prospect to New, into the sales queue. */
export function QualifyProspectButton({ leadId }: { leadId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      title="Worth a salesperson's call: move to New, into the lead list and calling queue."
      onClick={() =>
        start(async () => {
          const result = await qualifyProspect(leadId);
          if (!result.ok) window.alert(result.error);
          // A full reload: see log-touch-button.tsx.
          else softReload();
        })
      }
    >
      <UserCheck className="h-4 w-4" /> Qualify to lead
    </Button>
  );
}
