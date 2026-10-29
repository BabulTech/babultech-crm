import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A prospect as a recipient of a mass email: the business's main address and
 * the person to greet. The main person's work email comes first, then the
 * business's primary email, then any other address it has.
 */
export interface ProspectRecipient {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string;
  email: string | null;
  archived: boolean;
}

export async function loadProspectRecipients(db: SupabaseClient, ids: string[]): Promise<ProspectRecipient[]> {
  if (!ids.length) return [];
  const { data } = await db
    .from("prospect")
    .select("id, \"businessName\", status, emails:prospect_email ( email, \"isPrimary\" ), people:prospect_person ( name, email, \"isPrimary\" )")
    .in("id", ids)
    .is("deletedAt", null);
  return (data ?? []).map((p) => {
    const people = ((p.people ?? []) as { name: string; email: string | null; isPrimary: boolean }[]).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const emails = ((p.emails ?? []) as { email: string; isPrimary: boolean }[]).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const main = people[0];
    const [first, ...rest] = (main?.name ?? "").trim().split(/\s+/);
    return {
      id: String(p.id),
      firstName: first ?? "",
      lastName: rest.join(" ") || null,
      companyName: String(p.businessName),
      email: people.find((x) => x.email)?.email ?? emails[0]?.email ?? null,
      archived: p.status === "ARCHIVED",
    };
  });
}
