"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowDown, ArrowUp, Check, Pencil, Star, X } from "lucide-react";
import { holds } from "@/lib/nav-permissions";
import { FAVORITE_ACTIONS } from "@/lib/favorite-actions";
import { listShortcuts, moveShortcut, renameShortcut, toggleShortcut, type Shortcuts } from "@/server/favorites";

const CHANGED = "favorites-changed";
const changed = () => window.dispatchEvent(new Event(CHANGED));

/** The person's shortcuts, kept current as stars are clicked anywhere on the page. */
function useShortcuts() {
  const [data, setData] = useState<Shortcuts | null>(null);
  const load = useCallback(() => { listShortcuts().then(setData).catch(() => setData(null)); }, []);
  useEffect(() => {
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);
  return data;
}

/** The screen's own star, beside its title. Record pages have the record star instead. */
export function PageStar({ title }: { title: string }) {
  const pathname = usePathname();
  const data = useShortcuts();
  const [href, setHref] = useState(pathname);
  useEffect(() => { setHref(pathname + window.location.search); }, [pathname]);
  if (!data || /\/[0-9a-f]{8}-[0-9a-f-]{27}/i.test(pathname)) return null;
  const on = data.links.some((l) => l.href === href);
  return (
    <button type="button" aria-pressed={on} aria-label={on ? "Remove this screen from favourites" : "Add this screen to favourites"}
      title={on ? "In your favourites" : "Add this screen to your favourites"}
      className="align-middle text-muted-foreground hover:text-amber-500"
      onClick={async () => { await toggleShortcut("SCREEN", href, title, !on); changed(); }}>
      <Star className={`h-5 w-5 ${on ? "fill-amber-400 text-amber-500" : ""}`} />
    </button>
  );
}

/** Starred screens and actions, at the top of the sidebar. */
export function SidebarFavorites({ onNavigate, railed }: { onNavigate: () => void; railed: boolean }) {
  const data = useShortcuts();
  if (!data?.links.length || railed) return null;
  return (
    <div className="mb-3" data-testid="sidebar-favorites">
      <p className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Favourites</p>
      <ul className="space-y-0.5">
        {data.links.map((l) => (
          <li key={l.id}>
            {/* A plain link, so a filtered screen's query string takes effect. */}
            <a href={l.href} onClick={onNavigate} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" />
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Favourites button: open, rename, reorder and remove, and add actions. */
export function FavoritesMenu({ permissions }: { permissions: string[] }) {
  const data = useShortcuts();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  if (!data) return null;
  const has = (href: string) => data.links.some((l) => l.href === href);
  const actions = FAVORITE_ACTIONS.filter((a) => !a.permission || holds(permissions, a.permission));
  const icon = "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground";
  const run = async (p: Promise<unknown>) => { await p; changed(); };

  return (
    <div className="relative">
      <button type="button" aria-label="Favourites" aria-expanded={open} title="Favourites" className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        <Star className="h-4 w-4" />
      </button>
      {open && (
        <div role="dialog" aria-label="Favourites" className="fixed left-3 right-3 top-14 z-50 max-h-[75vh] overflow-y-auto rounded-lg border bg-card p-3 text-sm shadow-lg sm:right-auto sm:w-80">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-semibold">Favourites</p>
            <button type="button" aria-label="Close favourites" className={icon} onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
          </div>
          {data.links.length === 0 && data.records.length === 0 && <p className="mb-2 text-muted-foreground">Click the star beside any screen or record title to keep it here.</p>}
          <ul className="space-y-1">
            {data.links.map((l, i) => (
              <li key={l.id} className="flex items-center gap-1">
                {editing?.id === l.id ? (
                  <>
                    <input aria-label="Favourite name" autoFocus value={editing.label} maxLength={120} onChange={(e) => setEditing({ ...editing, label: e.target.value })} className="min-w-0 flex-1 rounded border bg-background px-2 py-1" />
                    <button type="button" aria-label="Save name" className={icon} onClick={() => { run(renameShortcut(l.id, editing.label)); setEditing(null); }}><Check className="h-3.5 w-3.5" /></button>
                  </>
                ) : (
                  <>
                    <a href={l.href} className="min-w-0 flex-1 truncate rounded px-1 py-1 hover:bg-accent">{l.label}</a>
                    <button type="button" aria-label={`Rename ${l.label}`} className={icon} onClick={() => setEditing({ id: l.id, label: l.label })}><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={`Move ${l.label} up`} disabled={i === 0} className={icon} onClick={() => run(moveShortcut(l.id, -1))}><ArrowUp className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={`Move ${l.label} down`} disabled={i === data.links.length - 1} className={icon} onClick={() => run(moveShortcut(l.id, 1))}><ArrowDown className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={`Remove ${l.label}`} className={icon} onClick={() => run(toggleShortcut(l.kind, l.href, l.label, false))}><X className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {data.records.length > 0 && (
            <>
              <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Records</p>
              <ul>
                {data.records.map((r) => (
                  <li key={r.href}><a href={r.href} className="flex justify-between gap-2 rounded px-1 py-1 hover:bg-accent"><span className="truncate">{r.label}</span><span className="text-xs text-muted-foreground">{r.type}</span></a></li>
                ))}
              </ul>
            </>
          )}
          <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</p>
          <ul>
            {actions.map((a) => {
              const on = has(a.href);
              return (
                <li key={a.href}>
                  <button type="button" aria-pressed={on} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent" onClick={() => run(toggleShortcut("ACTION", a.href, a.label, !on))}>
                    <Star className={`h-3.5 w-3.5 ${on ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`} /> {a.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
