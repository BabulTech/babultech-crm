"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-dropdown-menu";
import { Bell, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { markNotificationsRead, type NotificationItem } from "@/server/notifications";

/**
 * The bell: how many unread, and the latest few.
 *
 * Loaded after the page rather than with it, so it never slows a page down,
 * and refreshed on every navigation and once a minute while the tab is open.
 * Opening an item marks it read; "Mark all read" clears the lot.
 */

/**
 * The database keeps these times in UTC without saying so. Read in a browser
 * in Karachi, a bare "2026-09-29T10:00:00" would be taken as local time and be
 * five hours out.
 */
export function asUtc(iso: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - asUtc(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return asUtc(iso).toLocaleDateString("en-PK", { day: "numeric", month: "short" });
}

/**
 * The shell renders a bell for each layout (phone, rail, desktop), and each one
 * refreshes on every navigation. They share one request instead of each making
 * their own.
 */
let inflightBell: Promise<{ unread: number; items: NotificationItem[] } | null> | null = null;

function fetchBell() {
  inflightBell ??= fetch("/api/notifications/bell", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ unread: number; items: NotificationItem[] }>) : null))
    .finally(() => {
      inflightBell = null;
    });
  return inflightBell;
}

export function NotificationBell({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await fetchBell();
      if (!next) return;
      setUnread(next.unread);
      setItems(next.items);
    } catch {
      /* A failed refresh keeps what is showing; the next one will try again. */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function openItem(item: NotificationItem) {
    setOpen(false);
    if (!item.readAt) {
      setUnread((n) => Math.max(0, n - 1));
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)));
      // Before navigating: the bell refreshes on arrival, and would otherwise
      // read the count back before the mark had landed.
      await markNotificationsRead([item.id]).catch(() => {});
    }
    if (item.link) router.push(item.link);
  }

  async function markAll() {
    setUnread(0);
    setItems((list) => list.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    await markNotificationsRead();
  }

  return (
    <Popover.Root open={open} onOpenChange={(v) => { setOpen(v); if (v) void refresh(); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "relative grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-[16px] place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-card shadow-xl"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            <div className="flex items-center gap-3">
              {unread > 0 && (
                <button type="button" onClick={markAll} className="text-xs text-primary hover:underline">
                  Mark all read
                </button>
              )}
              <Link
                href="/notifications/settings"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Notification settings"
                title="Notification settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing yet. When work comes your way it shows here.</p>
            ) : (
              items.map((item) => (
                <Popover.Item
                  key={item.id}
                  onSelect={() => void openItem(item)}
                  className={cn(
                    "flex cursor-pointer gap-2.5 border-b px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-accent focus:bg-accent",
                    !item.readAt && "bg-primary/5",
                  )}
                >
                  <span
                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", item.readAt ? "bg-transparent" : "bg-primary")}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm", !item.readAt && "font-medium")}>{item.title}</span>
                    {item.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{item.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {timeAgo(item.createdAt)}
                      {item.actorName ? ` · ${item.actorName}` : ""}
                    </span>
                  </span>
                </Popover.Item>
              ))
            )}
          </div>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t px-3 py-2 text-center text-xs font-medium text-primary hover:bg-accent"
          >
            See all notifications
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
