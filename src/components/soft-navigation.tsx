"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresh and move without a full page load, callable from any handler.
 * The bridge in the root layout hands over the router; until it has, these
 * fall back to the browser's own reload so a save is never left unseen.
 */
let router: ReturnType<typeof useRouter> | null = null;

export function softReload() {
  if (router) router.refresh();
  else window.location.reload();
}

export function softGo(href: string) {
  if (router) router.push(href);
  else window.location.assign(href);
}

export function SoftNavigationBridge() {
  const r = useRouter();
  useEffect(() => {
    router = r;
  }, [r]);

  // Date and time boxes open their calendar wherever they are clicked. One
  // listener here, because a handler on Input breaks server-rendered pages.
  useEffect(() => {
    const open = (e: MouseEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return;
      if (!["date", "datetime-local", "month", "week", "time"].includes(el.type)) return;
      try { el.showPicker?.(); } catch { /* Typing still works. */ }
    };
    document.addEventListener("click", open);
    return () => document.removeEventListener("click", open);
  }, []);
  return null;
}
