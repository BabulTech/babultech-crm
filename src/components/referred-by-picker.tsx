"use client";
import { softReload } from "@/components/soft-navigation";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Input } from "@/components/ui";
import { searchContactsForReferral, setReferredBy } from "@/server/marketing";

/** Who referred this lead: a contact, chosen by typing their name. */
export function ReferredByPicker({
  leadId,
  current,
  canWrite,
}: {
  leadId: string;
  current: { id: string; name: string } | null;
  canWrite: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; company: string | null }[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      searchContactsForReferral(term).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [term]);

  const choose = (contactId: string | null) =>
    start(async () => {
      const result = await setReferredBy(leadId, contactId);
      if (!result.ok) return window.alert(result.error);
      setEditing(false);
      setTerm("");
      // A full reload: see log-touch-button.tsx.
      softReload();
    });

  if (!editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {current ? <Link href={`/contacts/${current.id}`} className="text-primary hover:underline">{current.name}</Link> : "—"}
        {canWrite && (
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setEditing(true)}>
            {current ? "Change" : "Add"}
          </button>
        )}
        {canWrite && current && (
          <button type="button" className="text-xs text-muted-foreground hover:underline" disabled={pending} onClick={() => choose(null)}>
            Remove
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="w-full space-y-1">
      <Input autoFocus placeholder="Type a contact's name or email" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Referring contact" />
      {results.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" disabled={pending} onClick={() => choose(r.id)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent">
                {r.name}
                {r.company && <span className="text-xs text-muted-foreground"> · {r.company}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setEditing(false)}>Cancel</button>
    </div>
  );
}
