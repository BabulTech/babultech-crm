"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requireUser, can } from "@/lib/authz";
import { describeInvalid } from "@/lib/form-errors";
import { duplicateFromError, describeDuplicate } from "@/lib/duplicates";
import { SEQUENCES } from "@/lib/numbering";
import { ACTIVITY_LABELS, CHANNEL_LABELS, type Channel } from "@/lib/prospect-outreach";
import type { ActionResult } from "./partners";

/**
 * The hand-off from marketing to sales: a qualified prospect becomes a CRM
 * lead, and from there the existing sales flow takes over unchanged.
 *
 * Needs prospect:qualify, not lead:write - the people who qualify are
 * marketing, who may hold no sales permissions - so the lead is written with
 * the service role once that permission and the prospect's access have been
 * checked. The lead carries what marketing learned: the chosen decision maker
 * as its contact person, the business details, and the outreach history.
 */

const qualifySchema = z.object({
  prospectId: z.string().uuid(),
  ownerUserId: z.string().uuid({ message: "Sales owner: choose one from the list." }),
  personId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  campaignId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  note: z.string().max(4000).optional().nullable(),
});

/** Splits "Dr Jane van Dyk" into a first name and the rest. */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0].slice(0, 100), lastName: "—" };
  return { firstName: parts[0].slice(0, 100), lastName: parts.slice(1).join(" ").slice(0, 100) };
}

export async function qualifyProspect(input: z.input<typeof qualifySchema>): Promise<ActionResult<{ leadId: string; leadNumber: string }>> {
  const auth = await authorize(PERMISSIONS.PROSPECT_QUALIFY);
  if (!auth.ok) return auth;
  const parsed = qualifySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  const { prospectId, ownerUserId, personId, campaignId, note } = parsed.data;

  // Read through the caller's own access: someone who cannot see the
  // prospect cannot qualify it.
  const db = await supabaseServer();
  const { data: p } = await db.from("prospect")
    .select("*, phones:prospect_phone ( phone, \"isPrimary\" ), emails:prospect_email ( email, \"isPrimary\" ), people:prospect_person ( id, name, role, email, phone, \"personalEmail\", \"personalPhone\" ), dataset:prospect_dataset ( name )")
    .eq("id", prospectId).is("deletedAt", null).maybeSingle();
  if (!p) return { ok: false, error: "That prospect is not available to you." };
  if (p.status === "QUALIFIED" && p.qualifiedLeadId) return { ok: false, error: "This prospect has already been qualified." };

  const admin = supabaseAdmin();
  const { data: owner } = await admin.from("app_user").select("id, status, \"partnerId\"").eq("id", ownerUserId).is("deletedAt", null).maybeSingle();
  if (!owner || owner.status !== "ACTIVE" || owner.partnerId) return { ok: false, error: "Sales owner: choose an active member of the team." };

  const people = (p.people ?? []) as { id: string; name: string; role: string | null; email: string | null; phone: string | null; personalEmail: string | null; personalPhone: string | null }[];
  const person = personId ? people.find((x) => x.id === personId) : null;
  if (personId && !person) return { ok: false, error: "Contact person: choose someone at this business." };
  const primary = <T extends { isPrimary: boolean }>(list: T[] | null) => (list ?? []).slice().sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
  const phone = person?.phone || person?.personalPhone || primary(p.phones as { phone: string; isPrimary: boolean }[])?.phone || null;
  const email = person?.email || person?.personalEmail || primary(p.emails as { email: string; isPrimary: boolean }[])?.email || null;
  const name = person ? splitName(person.name) : { firstName: String(p.businessName).slice(0, 100), lastName: "—" };

  let campaignName: string | null = null;
  // The marketing campaign the outreach belonged to gets the credit for the lead.
  let marketingCampaignId: string | null = null;
  if (campaignId) {
    const { data: c } = await db.from("prospect_campaign").select("name, \"marketingCampaignId\"").eq("id", campaignId).maybeSingle();
    campaignName = c?.name ?? null;
    marketingCampaignId = (c?.marketingCampaignId as string | null) ?? null;
  }

  // What marketing did, newest first, for the lead's description.
  const { data: history } = await db.from("prospect_activity")
    .select("type, channel, content, \"occurredAt\", actor:app_user ( fullName ), person:prospect_person ( name )")
    .eq("prospectId", prospectId).order("occurredAt", { ascending: false }).limit(30);
  const lines = (history ?? []).map((a) => {
    const actor = (Array.isArray(a.actor) ? a.actor[0] : a.actor) as { fullName?: string } | null;
    const who = (Array.isArray(a.person) ? a.person[0] : a.person) as { name?: string } | null;
    return `- ${String(a.occurredAt).slice(0, 10)} ${ACTIVITY_LABELS[a.type] ?? a.type}`
      + (a.channel ? ` (${CHANNEL_LABELS[a.channel as Channel] ?? a.channel})` : "")
      + (who?.name ? ` with ${who.name}` : "")
      + (actor?.fullName ? `, by ${actor.fullName}` : "")
      + (a.content ? `: ${a.content}` : "");
  });
  const description = [
    note?.trim() ? `From marketing: ${note.trim()}` : null,
    person ? `Contact: ${person.name}${person.role ? `, ${person.role}` : ""}` : null,
    lines.length ? `Outreach before qualifying:\n${lines.join("\n")}` : null,
  ].filter(Boolean).join("\n\n") || null;

  const { data: created, error } = await admin.rpc("create_record", {
    p_table: "lead",
    p_payload: {
      firstName: name.firstName, lastName: name.lastName, companyName: String(p.businessName).slice(0, 200),
      jobTitle: person?.role ?? null, email, phone, website: p.website ? String(p.website).slice(0, 255) : null,
      industry: p.industry ? String(p.industry).slice(0, 100) : null,
      street: p.street ? String(p.street).slice(0, 255) : null, city: p.city, state: p.region ? String(p.region).slice(0, 100) : null, country: p.country,
      region: p.region, icpTier: p.icpTier, googleRating: p.googleRating, googleReviewCount: p.googleReviewCount, googleMapsUrl: p.googleMapsUrl,
      leadList: (Array.isArray(p.dataset) ? p.dataset[0] : p.dataset)?.name ?? null,
      leadSource: `Prospecting${campaignName ? ` - ${campaignName}` : ""}`.slice(0, 100),
      ownerUserId, status: "NEW", description, campaignId: marketingCampaignId, updatedAt: new Date().toISOString(),
    },
    p_number_field: "leadNumber",
    p_sequence: SEQUENCES.LEAD,
  });
  if (error) {
    const match = duplicateFromError(error);
    if (match) return { ok: false, error: `${describeDuplicate(match)}. Open that lead instead of creating another.${match.id && match.entity === "lead" ? ` (/leads/${match.id})` : ""}` };
    return { ok: false, error: `Could not create the lead: ${error.message}` };
  }
  const lead = (Array.isArray(created) ? created[0] : created) as { id: string; leadNumber: string };

  const now = new Date().toISOString();
  await admin.from("prospect").update({ status: "QUALIFIED", qualifiedLeadId: lead.id, qualifiedAt: now, qualifiedById: auth.user.id, updatedAt: now }).eq("id", prospectId);
  if (campaignId) await admin.from("prospect_campaign_entry").update({ status: "won", updatedAt: now }).eq("campaignId", campaignId).eq("prospectId", prospectId);
  await admin.from("prospect_activity").insert({ prospectId, campaignId, type: "STATUS_CHANGED", content: `Qualified and handed to sales as ${lead.leadNumber}`, actorId: auth.user.id });
  await admin.from("note").insert({
    id: randomUUID(), title: "Handed over from prospecting", relatedEntityType: "Lead", relatedEntityId: lead.id, createdById: auth.user.id, updatedAt: now,
    content: `Qualified by marketing from prospect "${p.businessName}"${campaignName ? ` in the ${campaignName} campaign` : ""}.${note?.trim() ? `\n\n${note.trim()}` : ""}`,
  });

  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/leads");
  return { ok: true, data: { leadId: lead.id, leadNumber: lead.leadNumber } };
}

/** The prospect a lead came from, for the lead's page. Null when it did not. */
export async function getLeadProspectOrigin(leadId: string) {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.LEAD_READ)) return null;
  const { data } = await supabaseAdmin().from("prospect")
    .select("id, \"businessName\", \"qualifiedAt\", qualifier:app_user!prospect_qualifiedById_fkey ( fullName )")
    .eq("qualifiedLeadId", leadId).maybeSingle();
  if (!data) return null;
  const q = (Array.isArray(data.qualifier) ? data.qualifier[0] : data.qualifier) as { fullName?: string } | null;
  return {
    id: data.id as string, businessName: data.businessName as string, qualifiedAt: data.qualifiedAt as string | null,
    qualifiedBy: q?.fullName ?? null,
    canOpen: can(me, PERMISSIONS.PROSPECT_READ) || can(me, PERMISSIONS.PROSPECT_WRITE),
  };
}
