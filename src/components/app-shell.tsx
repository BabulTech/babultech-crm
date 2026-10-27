"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, BarChart3, Megaphone, UserPlus, Building2, Users, Target,
  FileText, FileSignature, Handshake, Coins, LifeBuoy, FolderKanban,
  Receipt, Package, CalendarCheck, Menu, X, LogOut, Clock, UsersRound, Banknote,
  ShieldCheck, UserCog, Settings, BookOpen, CheckSquare, FileInput, Wallet, Stamp,
  ChevronDown, Trash2, BookMarked, Landmark, PanelLeftClose, PanelLeftOpen, KeyRound, CalendarClock, HeartPulse, CalendarSync, RefreshCw, ContactRound, ListChecks, IdCard, ScrollText,
} from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { holdsAny } from "@/lib/nav-permissions";
import { signOutAction } from "@/lib/sign-out-action";
import { MobileNav } from "./mobile-nav";
import { CommandPalette } from "./command-palette";
import { NotificationBell } from "./notification-bell";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Phase 3+ modules are visible but marked so nobody expects a working screen. */
  soon?: boolean;
  /**
   * Permissions that reveal this destination. Holding any one is enough, which
   * is what "read it or write it" needs: a role with only `case:write` still
   * belongs on the Cases screen.
   *
   * Omitted means everyone — the dashboard, my work, and the guide are not
   * gated on anything, because every signed-in person has their own copy.
   */
  permissions?: string[];
  /** Administrators only, whatever the permissions say - for a screen in a mixed group. */
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  /**
   * A group disappears once every item inside it is filtered out, so a group
   * needs no permission of its own. A whole group can still be hidden by role
   * with this flag; today screens are marked one by one instead (NavItem.adminOnly).
   */
  adminOnly?: boolean;
}

const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/company", label: "Company information", icon: Landmark, adminOnly: true },
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/reports", label: "Reports", icon: BookOpen, permissions: ["opportunity:read", "lead:read", "case:read", "project:read"] },
      { href: "/recycle-bin", label: "Recycle bin", icon: Trash2, permissions: ["record:delete"] },
    ],
  },
  {
    // Data quality and Approvals are a Manager's too, so this group is not
    // hidden by role; the screens only administrators may open are marked
    // one by one.
    label: "Admin",
    items: [
      { href: "/data-quality", label: "Data quality", icon: ListChecks, permissions: ["account:read", "lead:read", "opportunity:read", "case:read", "project:read"] },
      { href: "/approvals", label: "Approvals", icon: Stamp, permissions: ["quotation:approve", "invoice:approve", "invoice:void", "payable:approve", "expense:approve", "time:approve", "commission:approve"] },
      { href: "/users", label: "Users", icon: ShieldCheck, adminOnly: true },
      { href: "/jobs", label: "Background jobs", icon: RefreshCw, adminOnly: true },
      { href: "/email/senders", label: "Sender addresses", icon: Megaphone, adminOnly: true },
      { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
    ],
  },
  {
    label: "Prospecting",
    items: [
      { href: "/prospects", label: "Prospects", icon: Target, permissions: ["prospect:read", "prospect:write"] },
      { href: "/prospects/campaigns", label: "Outreach campaigns", icon: Megaphone, permissions: ["prospect:read", "prospect:write"] },
      { href: "/prospects/tasks", label: "Outreach tasks", icon: ListChecks, permissions: ["prospect:read", "prospect:write"] },
      { href: "/prospects/analytics", label: "Outreach analytics", icon: BarChart3, permissions: ["prospect:read", "prospect:write"] },
      { href: "/prospects/datasets", label: "Datasets", icon: FileText, permissions: ["prospect:read", "prospect:write"] },
      { href: "/prospects/import", label: "Import prospects", icon: UserPlus, permissions: ["prospect:write"] },
    ],
  },
  {
    label: "Marketing",
    items: [
      { href: "/campaigns", label: "Marketing campaigns", icon: Megaphone, permissions: ["lead:read"] },
      { href: "/leads", label: "Leads", icon: UserPlus, permissions: ["lead:read"] },
      { href: "/email/templates", label: "Email templates", icon: FileText, permissions: ["lead:read", "account:read"] },
    ],
  },
  {
    label: "Sales",
    items: [
      { href: "/accounts", label: "Accounts", icon: Building2, permissions: ["account:read"] },
      { href: "/accounts/health", label: "Account health", icon: HeartPulse, permissions: ["account:read"] },
      { href: "/contacts", label: "Contacts", icon: Users, permissions: ["account:read"] },
      { href: "/opportunities", label: "Opportunities", icon: Target, permissions: ["opportunity:read"] },
      { href: "/quotations", label: "Quotations", icon: FileText, permissions: ["quotation:read", "quotation:write"] },
      { href: "/contracts", label: "Contracts", icon: FileSignature, permissions: ["contract:read", "contract:write", "opportunity:read"] },
      { href: "/accounts/renewals", label: "Renewals", icon: CalendarSync, permissions: ["contract:read", "contract:write", "opportunity:read"] },
      { href: "/products", label: "Products & Services", icon: Package, permissions: ["opportunity:read"] },
      { href: "/price-books", label: "Price books", icon: BookMarked, permissions: ["opportunity:read"] },
    ],
  },
  {
    label: "Partners",
    items: [
      { href: "/partners", label: "Partners", icon: Handshake, permissions: ["partner:read"] },
      { href: "/commissions", label: "Commissions", icon: Coins, permissions: ["commission:read"] },
    ],
  },
  {
    label: "Delivery",
    items: [
      // Everyone's own work: tasks, projects, cases and activities assigned to them.
      { href: "/my-work", label: "My work", icon: CheckSquare },
      { href: "/cases", label: "Support Cases", icon: LifeBuoy, permissions: ["case:read"] },
      { href: "/knowledge", label: "Knowledge base", icon: BookMarked, permissions: ["case:read"] },
      { href: "/projects", label: "Projects", icon: FolderKanban, permissions: ["project:read"] },
      { href: "/timesheets", label: "Timesheets", icon: Clock, permissions: ["project:read"] },
      { href: "/resources", label: "Resources", icon: UsersRound, permissions: ["time:approve"] },
      { href: "/activities", label: "Activities", icon: CalendarCheck },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/invoices", label: "Invoices", icon: Receipt, permissions: ["invoice:read"] },
      { href: "/payments", label: "Payments", icon: Banknote, permissions: ["invoice:read"] },
      { href: "/vendor-bills", label: "Vendor Bills", icon: FileInput, permissions: ["invoice:read"] },
      { href: "/expenses", label: "Expenses", icon: Wallet, permissions: ["expense:read"] },
      { href: "/finance/periods", label: "Periods", icon: CalendarClock, permissions: ["invoice:read"] },
    ],
  },
  {
    // Human resources: hiring and contracts. Pay is confidential, so this is
    // its own pair of permissions rather than part of Admin.
    label: "HR",
    items: [
      { href: "/people", label: "People", icon: IdCard, permissions: ["people:read", "people:write"] },
      { href: "/people/templates", label: "Contract templates", icon: ScrollText, permissions: ["people:write"] },
    ],
  },
  {
    // Its own group rather than an item under Admin: secret:read is
    // meant to be grantable to someone who is not an administrator, and that
    // group is hidden wholesale by role.
    label: "Security",
    items: [
      { href: "/vault", label: "Vault", icon: KeyRound, permissions: ["secret:read"] },
    ],
  },
  {
    label: "Help",
    items: [{ href: "/guide", label: "User guide", icon: BookOpen }],
  },
];

export function AppShell({
  user,
  isAdmin,
  permissions,
  children,
}: {
  user: { fullName: string; email: string; roleName: string };
  isAdmin: boolean;
  /** The signed-in role's permission strings, straight from security_role. */
  permissions: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Navigation is built from the same permissions the server enforces, so a
  // link is shown only where the page behind it will actually load. This is
  // presentation, not protection — every page still calls requirePermission —
  // but a menu full of screens that refuse on arrival is its own kind of broken,
  // and a consultant has no reason to look at a Finance heading at all.
  //
  // A group whose items all filter out disappears with them: an "Overview"
  // header above nothing is worse than no header.
  const nav = NAV.filter((group) => !group.adminOnly || isAdmin)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (!item.adminOnly || isAdmin) && holdsAny(permissions, item.permissions)),
    }))
    .filter((group) => group.items.length > 0);

  /**
   * Which groups are open.
   *
   * Fully expanded the nav is around 1,200px tall against roughly 840px of
   * viewport on a 1080p screen, so Settings and the user guide sat below a
   * scrollbar — the thing you reach for least is the thing you have to scroll
   * to. Collapsing the groups you are not working in brings it back inside the
   * screen.
   *
   * The group containing the current page always opens, whatever was saved:
   * arriving on a screen and not seeing where you are in the tree is worse than
   * ignoring a stored preference.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  /**
   * Whether the whole sidebar is reduced to an icon rail.
   *
   * Separate from `collapsed` above, which hides items inside a group. This
   * hides the labels and narrows the column, trading the ability to read a
   * destination for about 190px of width — worth it on the wide tables, where
   * the sidebar costs more than it earns.
   *
   * Starts expanded on every load and is corrected from storage in the effect
   * below, rather than read during render: the server has no localStorage, so
   * reading it inline would render a different tree on the client and trip
   * hydration. One frame at the stored width is the cost of that correctness,
   * and `transition-[width]` is suppressed until after that first paint so the
   * rail does not visibly slide open on arrival.
   */
  const [railed, setRailed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("nav-collapsed");
      if (saved) setCollapsed(JSON.parse(saved));
      setRailed(window.localStorage.getItem("nav-railed") === "1");
    } catch {
      // A private window or blocked storage is not a reason to break the nav.
    }
    setHydrated(true);
  }, []);

  function toggleRail() {
    setRailed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("nav-railed", next ? "1" : "0");
      } catch {
        // Ignored for the same reason as above.
      }
      return next;
    });
  }

  function toggleGroup(label: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        window.localStorage.setItem("nav-collapsed", JSON.stringify(next));
      } catch {
        // Ignored for the same reason as above.
      }
      return next;
    });
  }

  const paletteItems = useMemo(
    () =>
      nav.flatMap((group) =>
        group.items
          .filter((item) => !item.soon)
          .map((item) => ({ href: item.href, label: item.label, group: group.label })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions.join(","), isAdmin],
  );

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen">
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r bg-card shadow-lg transition-transform",
          // Only the desktop column narrows. On mobile the sidebar is an
          // overlay you open and dismiss, so a rail there would be a smaller
          // target for no gain in space.
          hydrated && "lg:transition-[width]",
          railed && "lg:w-16",
          // Sticks to the viewport on desktop instead of flowing with the page.
          //
          // `lg:static` put the sidebar in the page's own flow inside a
          // min-h-screen row, so on a long list it grew as tall as the content
          // and the sign-out block sat wherever the page happened to end —
          // several screens down. The nav already had `flex-1 overflow-y-auto`,
          // but a scroll container only scrolls when something bounds its
          // height, and nothing did.
          //
          // Sticky with an explicit viewport height gives it that bound: the
          // brand and the account block stay put, and only the nav between them
          // moves. h-screen rather than 100dvh because the sidebar is hidden on
          // the phones where the two differ.
          "lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:shadow-none",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className={cn(
          "flex h-14 shrink-0 items-center justify-between border-b",
          railed ? "lg:justify-center lg:px-0" : "px-5",
        )}>
          <Link
            href="/"
            className={cn("flex items-center gap-2 font-semibold", railed && "lg:gap-0")}
            title={railed ? "BabulTech CRM" : undefined}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-primary text-xs font-bold text-primary-foreground">
              BT
            </span>
            <span className={cn(railed && "lg:hidden")}>BabulTech CRM</span>
          </Link>
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
          {/* On a phone the bell sits in the top bar instead. */}
          <div className={cn("hidden flex-1 justify-end pr-1 lg:flex", railed && "lg:hidden")}>
            <NotificationBell />
          </div>
          {/* Desktop only: the mobile sidebar closes with the X above. */}
          <button
            type="button"
            onClick={toggleRail}
            className={cn(
              "hidden text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:block",
              railed && "lg:hidden",
            )}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        {/* When railed the brand row centres the logo, so the reopen control
            moves to its own row rather than fighting it for the width. */}
        {railed && (
          <button
            type="button"
            onClick={toggleRail}
            className="hidden shrink-0 justify-center border-b py-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        {railed && (
          <div className="hidden shrink-0 justify-center border-b py-1.5 lg:flex">
            <NotificationBell />
          </div>
        )}

        {/* Above the groups, because it is the fastest route to anything and
            should not itself need scrolling to. */}
        {/* Hidden on the rail: a search input cannot be usefully rendered at
            64px, and ⌘K still opens it from anywhere. */}
        <div className={cn("shrink-0 px-3 pt-3", railed && "lg:hidden")}>
          <CommandPalette items={paletteItems} />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {nav.map((group) => {
            // The group holding the current page is forced open, so you can
            // always see where you are even if it was collapsed last visit.
            const hasActive = group.items.some((item) => isActive(item.href));
            const isOpen = hasActive || !collapsed[group.label];

            return (
            <div key={group.label} className="mb-3">
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={isOpen}
                // A full-width row rather than a small chevron: Fitts's Law
                // rewards the large target, and there is nothing else on this
                // line to hit by mistake.
                className={cn(
                  "mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  railed && "lg:hidden",
                )}
              >
                <span className="flex-1 text-left">{group.label}</span>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform",
                    !isOpen && "-rotate-90",
                  )}
                />
              </button>
              {/* On the rail the group header is hidden, so a collapsed group
                  would be an unexplained gap. Items always show there. */}
              <ul className={cn("space-y-0.5", !isOpen && (railed ? "hidden lg:block" : "hidden"))}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        // title, so a railed icon still says what it is on hover.
                        title={railed ? item.label : undefined}
                        className={cn(
                          "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-all",
                          railed && "lg:justify-center lg:gap-0 lg:px-0",
                          isActive(item.href)
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {/* A bar on the active item, so the current page is
                            findable without reading every label. */}
                        {isActive(item.href) && (
                          <span
                            className={cn(
                              "absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary",
                              railed ? "-left-1" : "-left-3",
                            )}
                            aria-hidden
                          />
                        )}
                        <Icon
                          className={cn(
                            "h-4 w-4 shrink-0 transition-transform",
                            !isActive(item.href) && "group-hover:scale-110",
                          )}
                        />
                        <span className={cn("flex-1", railed && "lg:hidden")}>{item.label}</span>
                        {item.soon && (
                          <span className={cn(
                            "rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground",
                            railed && "lg:hidden",
                          )}>
                            Phase 3
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
            );
          })}
        </nav>

        {/* shrink-0 so a long nav cannot squeeze this out of the layout: it is
            the one thing that must always be reachable without scrolling. */}
        <div className={cn("shrink-0 border-t p-3", railed && "lg:px-1.5")}>
          <div className={cn(
            "flex items-center gap-2.5 rounded-lg bg-muted/40 px-2 py-2 transition-colors hover:bg-muted/70",
            // Railed, the row stacks: avatar over sign-out. Side by side at
            // 64px leaves each about 24px, which is below a comfortable target
            // and puts sign-out within a few pixels of the profile link.
            railed && "lg:flex-col lg:gap-1.5 lg:px-0",
          )}>
            {/* The avatar is the profile link on the rail, where the name it
                normally sits beside is hidden. Expanded, the name carries the
                link and this stays decorative. */}
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              className={cn("shrink-0", !railed && "pointer-events-none")}
              tabIndex={railed ? undefined : -1}
              title={railed ? `${user.fullName}, ${user.roleName}` : undefined}
              aria-label={railed ? "Your profile" : undefined}
              aria-hidden={!railed}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold">
                {initials(user.fullName)}
              </span>
            </Link>
            <Link
              href="/profile"
              className={cn("min-w-0 flex-1", railed && "lg:hidden")}
              onClick={() => setOpen(false)}
            >
              <p className="truncate text-sm font-medium hover:underline">{user.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{user.roleName}</p>
            </Link>
            <form action={signOutAction} className="shrink-0">
              <button
                type="submit"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Sign out"
                title={railed ? "Sign out" : undefined}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex-1 font-semibold">BabulTech CRM</span>
          <NotificationBell />
        </header>
        <main className="flex-1 p-5 pb-24 lg:p-8 lg:pb-8">
          <div className="mx-auto w-full max-w-[1600px] fade-in">{children}</div>
        </main>
      </div>

      <MobileNav onOpenMenu={() => setOpen(true)} permissions={permissions} />
    </div>
  );
}
