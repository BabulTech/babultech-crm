"use server";

import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, requireUser, can } from "@/lib/authz";

/**
 * Outreach analytics for the Prospecting section, counted in the database
 * (prospect_outreach_analytics) as the viewer, so each person sees only the
 * campaigns they may see.
 */

export interface OutreachAnalytics {
  totals: { emails: number; followups: number; replies: number; callsNoAnswer: number; callsConnected: number; voicemails: number; meetings: number; prospectsTouched: number };
  daily: { day: string; sends: number; replies: number; calls: number; connected: number; meetings: number; firstAt: string | null; lastAt: string | null }[];
  people: { id: string | null; name: string; sends: number; calls: number; connected: number; replies: number; meetings: number }[];
  hours: { hour: number; n: number; good: number }[];
  weekdays: { dow: number; calls: number; connected: number; replies: number }[];
  campaigns: { id: string; name: string; total: number; worked: number; replied: number; meetings: number; won: number }[];
  funnel: { inCampaigns: number; worked: number; replied: number; meetings: number; qualified: number };
}

export async function getOutreachAnalytics(input: { from: string; to: string; campaignId?: string | null; userId?: string | null }): Promise<OutreachAnalytics> {
  const me = await requireUser();
  if (!can(me, PERMISSIONS.PROSPECT_READ) && !can(me, PERMISSIONS.PROSPECT_WRITE)) throw new Error("You do not have access to prospects.");
  const db = await supabaseServer();
  const { data, error } = await db.rpc("prospect_outreach_analytics", {
    p_from: input.from, p_to: input.to, p_campaign: input.campaignId || null, p_user: input.userId || null,
  });
  if (error) throw new Error(`Could not load outreach analytics: ${error.message}`);
  return data as OutreachAnalytics;
}
