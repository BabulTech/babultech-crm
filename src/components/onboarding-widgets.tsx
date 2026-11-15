import Link from "next/link";
import { Rocket } from "lucide-react";
import { listMyOnboardingSteps, listOnboardingsForAccount } from "@/server/onboarding";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@/components/ui";
import { formatDate } from "@/lib/utils";

/** My work: onboarding steps that are mine to do. Hidden when there are none. */
export async function MyOnboardingSteps() {
  const steps = await listMyOnboardingSteps();
  if (steps.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card className="mt-6" data-my-onboarding>
      <CardHeader className="flex flex-row items-center gap-2">
        <Rocket className="h-4 w-4 text-muted-foreground" />
        <CardTitle>My onboarding steps</CardTitle>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {steps.map((s) => (
          <Link key={s.id} href={`/onboarding/${s.onboarding!.id}`} className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-muted/40">
            <span>
              <span className="font-medium">{s.title}</span>
              <span className="text-muted-foreground"> · {s.onboarding!.name}</span>
              {s.stepType === "CUSTOMER" && <Badge tone="warning" className="ml-2">From customer</Badge>}
            </span>
            <span className={s.dueDate && s.dueDate < today ? "font-medium text-red-600" : "text-muted-foreground"}>{formatDate(s.dueDate)}</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

/** Account page: its onboarding, until it is live. */
export async function AccountOnboardingBadge({ accountId }: { accountId: string }) {
  const rows = await listOnboardingsForAccount(accountId);
  if (rows.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2" data-account-onboarding>
      {rows.map((o) => (
        <Link key={o.id} href={`/onboarding/${o.id}`}>
          <Badge tone={o.status === "LIVE" ? "success" : o.status === "CANCELLED" ? "neutral" : o.summary.overdue ? "danger" : "info"}>
            {o.status === "LIVE" ? `Live since ${formatDate(o.wentLiveAt)}` : o.status === "CANCELLED" ? "Onboarding cancelled" : `Onboarding ${o.summary.done}/${o.summary.total}${o.summary.overdue ? `, ${o.summary.overdue} overdue` : ""}`} · {o.onboardingNumber}
          </Badge>
        </Link>
      ))}
    </div>
  );
}
