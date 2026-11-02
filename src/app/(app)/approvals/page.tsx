import Link from "next/link";
import {
  FileText, Wallet, Clock, FileInput, Coins, ArrowRight, Lock, type LucideIcon,
} from "lucide-react";
import { getPendingApprovals, type ApprovalKind } from "@/server/approvals";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import {
  PageHeader, Card, CardHeader, CardTitle, CardContent, Badge,
  StatTile, EmptyState, Forbidden,
} from "@/components/ui";
import { formatMoney, formatDate, formatMoneyTotal } from "@/lib/utils";

const KIND: Record<ApprovalKind, { label: string; icon: LucideIcon; href: string }> = {
  quotation: { label: "Quotation", icon: FileText, href: "/quotations" },
  expense: { label: "Expense", icon: Wallet, href: "/expenses" },
  timesheet: { label: "Timesheet", icon: Clock, href: "/timesheets/approvals" },
  "vendor-bill": { label: "Vendor bill", icon: FileInput, href: "/vendor-bills" },
  commission: { label: "Partner rate requests", icon: Coins, href: "/commissions?view=requests" },
  "partner-change": { label: "Partner profile changes", icon: FileInput, href: "/partners" },
};

/**
 * One queue for everything waiting on a decision.
 *
 * Approvals live with the record they belong to — an expense is approved on
 * the expense screen, where the receipt and the category are visible. This
 * gathers them so nothing sits unnoticed on a screen nobody opened, and sends
 * the reader to the place the decision is actually made.
 */
export default async function ApprovalsPage() {
  const me = await requireUser();

  const canApproveAnything =
    can(me, PERMISSIONS.QUOTATION_APPROVE) ||
    can(me, PERMISSIONS.INVOICE_APPROVE) ||
    can(me, PERMISSIONS.EXPENSE_APPROVE) ||
    can(me, PERMISSIONS.TIME_APPROVE) ||
    can(me, PERMISSIONS.COMMISSION_APPROVE) ||
    can(me, PERMISSIONS.ADMIN);

  if (!canApproveAnything) return <Forbidden what="approvals" />;

  const { items, byKind, totalValue, oldestDays } = await getPendingApprovals();

  const waitingOver3Days = items.filter(
    (i) => Date.now() - new Date(i.waitingSince).getTime() > 3 * 86_400_000,
  );

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Everything waiting on your decision, oldest first. Each one opens where the decision is made."
      />

      {items.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="When a quotation, expense, timesheet, vendor bill or a partner's rate request needs a decision from you, it appears here."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Waiting on you"
              value={String(items.length)}
              tone={items.length > 0 ? "warning" : "success"}
            />
            <StatTile
              label="Value at stake"
              value={formatMoneyTotal(totalValue)}
              sublabel="Where the item has an amount"
            />
            <StatTile
              label="Waiting over 3 days"
              value={String(waitingOver3Days.length)}
              tone={waitingOver3Days.length > 0 ? "danger" : "success"}
            />
            <StatTile
              label="Oldest"
              value={oldestDays === 0 ? "Today" : `${oldestDays} day${oldestDays === 1 ? "" : "s"}`}
              tone={oldestDays > 7 ? "danger" : oldestDays > 3 ? "warning" : "neutral"}
            />
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {(Object.entries(byKind) as [ApprovalKind, number][]).map(([kind, count]) => {
              const meta = KIND[kind];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <Link key={kind} href={meta.href}>
                  <Badge tone="neutral" className="px-3 py-1">
                    <Icon className="h-3.5 w-3.5" /> {count} {meta.label.toLowerCase()}
                    {count === 1 ? "" : "s"}
                  </Badge>
                </Link>
              );
            })}
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Queue</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y border-t">
                {items.map((item) => {
                  const meta = KIND[item.kind];
                  const Icon = meta?.icon ?? FileText;
                  const days = Math.floor(
                    (Date.now() - new Date(item.waitingSince).getTime()) / 86_400_000,
                  );

                  return (
                    <li key={`${item.kind}-${item.id}`}>
                      <Link
                        href={item.href}
                        className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-muted/50"
                      >
                        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          <Icon className="h-4 w-4" />
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.title}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {item.reference}
                            </span>
                            {item.blockedReason && (
                              <Badge tone="warning">
                                <Lock className="h-3 w-3" /> Not yours to approve
                              </Badge>
                            )}
                          </div>

                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {[
                              meta?.label,
                              item.subtitle,
                              item.requestedBy ? `from ${item.requestedBy}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>

                          {item.blockedReason && (
                            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                              {item.blockedReason}
                            </p>
                          )}
                        </div>

                        <div className="shrink-0 text-right">
                          {item.amount && (
                            <p className="font-medium tabular">
                              {formatMoney(item.amount, item.currencyCode ?? "PKR")}
                            </p>
                          )}
                          <p
                            className={`text-xs ${days > 3 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                          >
                            {days === 0 ? "Today" : `${days}d waiting`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(item.waitingSince)}
                          </p>
                        </div>

                        <ArrowRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
