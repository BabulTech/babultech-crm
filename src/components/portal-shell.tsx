"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Target, Coins, Building2, UserPlus, Package,
  Menu, X, LogOut, MessageSquare, UsersRound,
} from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { signOutAction } from "@/lib/sign-out-action";

/**
 * The external partner's shell. Deliberately a different component from
 * AppShell rather than a filtered version of it: a partner should never be one
 * misplaced condition away from seeing an internal menu item.
 */
const NAV = [
  { href: "/portal", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/portal/leads", label: "Leads", icon: UserPlus },
  { href: "/portal/deals", label: "Opportunities", icon: Target },
  { href: "/portal/customers", label: "Accounts", icon: Building2 },
  { href: "/portal/catalogue", label: "Products & Services", icon: Package },
  { href: "/portal/commissions", label: "Commission", icon: Coins, adminOnly: true },
  { href: "/portal/activities", label: "Activities", icon: MessageSquare },
  { href: "/portal/account/team", label: "Your team", icon: UsersRound },
];

export function PortalShell({
  partner,
  user,
  isAdmin = true,
  assistant,
  children,
}: {
  partner: { displayName: string; partnerNumber: string; tier: string };
  user: { fullName: string; email: string };
  /** A partner User does not see commission. */
  isAdmin?: boolean;
  /** The portal assistant's launcher, under the menu. */
  assistant?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen">
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-card transition-transform lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-5">
          <Link href="/portal" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded bg-primary text-xs font-bold text-primary-foreground">
              BT
            </span>
            <span>Partner Portal</span>
          </Link>
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b px-5 py-3">
          <p className="truncate text-sm font-medium">{partner.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {partner.partnerNumber} · {partner.tier.toLowerCase()}
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-0.5">
            {NAV.filter((item) => !("adminOnly" in item && item.adminOnly) || isAdmin).map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isActive(item.href, item.exact)
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {assistant && <div className="px-3 pb-3">{assistant}</div>}

        <div className="border-t p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">
              {initials(user.fullName)}
            </span>
            <Link href="/portal/account" className="min-w-0 flex-1" onClick={() => setOpen(false)}>
              <p className="truncate text-sm font-medium hover:underline">{user.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </Link>
            <form action={signOutAction}>
              <button type="submit" className="text-muted-foreground hover:text-foreground" aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b bg-card px-4 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold">Partner Portal</span>
        </header>
        <main className="flex-1 p-5 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
