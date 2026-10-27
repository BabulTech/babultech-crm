/**
 * The comparable form of a prospect's identifiers, for spotting the same
 * business twice. Safe for the browser and the server.
 */

/** "Joe's Plumbing, Inc." → "joesplumbinginc" */
export function normalizeName(value: string | null | undefined): string | null {
  const v = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return v || null;
}

/** "https://www.Example.com/contact?x=1" → "example.com" */
export function normalizeWebsite(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return v || null;
}

/** "+1 (416) 555-0100" → "14165550100" */
export function normalizePhone(value: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\D/g, "");
  return v || null;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const v = String(value ?? "").trim().toLowerCase();
  return v || null;
}
