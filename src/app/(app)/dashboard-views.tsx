"use client";

import { createContext, useContext, useTransition, type ReactNode, type TransitionStartFunction } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { PageSkeleton } from "@/components/page-skeleton";
import type { ModuleKey } from "@/lib/chart-palette";
import { MODULE_COLORS } from "@/lib/chart-palette";

export type ViewKey = "overview" | ModuleKey;

export interface ViewOption {
  key: ViewKey;
  label: string;
  /** Headline figure, so a closed view still says why it is worth opening. */
  hint?: string;
}

/**
 * Switching the dashboard between the whole business and one part of it.
 *
 * The dashboard put twenty-seven panels on one screen — pipeline, cash, delivery
 * load, support, partners, an activity stream and a change log, all at once. Each
 * one was individually reasonable and the sum was unreadable: everything equally
 * prominent is the same as nothing being prominent.
 *
 * Splitting by business area works here because the app already thinks that way.
 * The five module flags on the summary are permission-derived, so the views a
 * person can open are exactly the areas their role can see — a consultant is
 * never offered a Finance view that would refuse them, and nobody has to
 * maintain a second list of who sees what.
 *
 * The choice lives in the URL rather than component state, so a link to the
 * finance view is a link to the finance view — shareable, reloadable, and
 * survivable through the back button. `replace` keeps back meaning "the previous
 * page" rather than stepping through every tab visited.
 *
 * The dot beside each label carries the module's validated colour, which is the
 * same colour that module's marks use in every chart. Colour follows the entity,
 * so a reader learns "teal is finance" once.
 */
/**
 * A tab changes only the query string, which the route's loading.tsx does not
 * cover - so without this the old view sat on screen, unchanged, until the new
 * one arrived. The switch runs in a transition and the body below shows a
 * skeleton for as long as it is pending.
 */
const ViewTransition = createContext<{ pending: boolean; start: TransitionStartFunction } | null>(null);

export function DashboardViewTransition({ children }: { children: ReactNode }) {
  const [pending, start] = useTransition();
  return <ViewTransition.Provider value={{ pending, start }}>{children}</ViewTransition.Provider>;
}

export function DashboardViewBody({ children }: { children: ReactNode }) {
  const pending = useContext(ViewTransition)?.pending ?? false;
  if (!pending) return <>{children}</>;
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading view…</span>
      <PageSkeleton />
    </div>
  );
}

export function DashboardViews({
  views,
  active,
}: {
  views: ViewOption[];
  active: ViewKey;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const transition = useContext(ViewTransition);

  function select(key: ViewKey) {
    const next = new URLSearchParams(searchParams.toString());
    // Overview is the default, so it stays out of the URL — a clean address for
    // the common case.
    if (key === "overview") next.delete("view");
    else next.set("view", key);

    const query = next.toString();
    const go = () => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    if (transition) transition.start(go);
    else go();
  }

  return (
    <div
      role="tablist"
      aria-label="Dashboard view"
      className="flex items-center gap-1 overflow-x-auto border-b"
    >
      {views.map((view) => {
        const selected = view.key === active;
        const color =
          view.key === "overview" ? null : MODULE_COLORS[view.key as ModuleKey];

        return (
          <button
            key={view.key}
            role="tab"
            aria-selected={selected}
            onClick={() => select(view.key)}
            className={cn(
              "group relative flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {color && (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                // Inline because the value comes from a validated palette rather
                // than a Tailwind class, and it has to differ by theme.
                style={{ backgroundColor: `var(--module-${view.key})` }}
              />
            )}
            <span>{view.label}</span>
            {view.hint && (
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                {view.hint}
              </span>
            )}
            {selected && (
              <span
                aria-hidden
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
