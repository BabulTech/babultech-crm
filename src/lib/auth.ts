import { z } from "zod";
import { headers } from "next/headers";
import { after } from "next/server";
import { supabaseAdmin, supabaseSession } from "./supabase";
import { endViewAs } from "./view-as-session";

/**
 * Sign-in and sign-out against Supabase Auth.
 *
 * Supabase Auth is the only identity provider. It issues the JWT that
 * supabaseServer() puts on every query, so the session the user holds is the
 * same one the database authorizes against — there is no second session to keep
 * in sync.
 *
 * auth.users.id === app_user.id, so the profile lookup in lib/authz.ts keys
 * straight off the signed-in user id.
 */

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SignInResult = { ok: true; userId: string; startPage: string | null } | { ok: false; reason: string };

/**
 * Verifies credentials and starts a session.
 *
 * The password is checked by Supabase Auth, not here. The app_user row is
 * consulted only to reject accounts that are disabled or soft-deleted, which
 * Supabase Auth knows nothing about.
 */
export async function signInWithCredentials(
  email: string,
  password: string,
): Promise<SignInResult> {
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) return { ok: false, reason: "invalid" };

  const normalizedEmail = parsed.data.email.toLowerCase();

  const db = await supabaseSession();
  const { data, error } = await db.auth.signInWithPassword({
    email: normalizedEmail,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    await recordLoginEvent({ eventType: "SIGN_IN_FAILED", email: normalizedEmail, detail: "Wrong email or password" });
    return { ok: false, reason: "invalid" };
  }

  // Status and deletedAt live on app_user, so a suspended user still passes the
  // Supabase password check. Read them with the service role: at this instant
  // the cookie is set but this request's client was built before it existed,
  // and the lookup is pinned to the id Supabase just verified.
  const adminDb = supabaseAdmin();
  const { data: profile } = await adminDb
    .from("app_user")
    .select("id, status, deletedAt, preference:user_preference ( startPage )")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || profile.status !== "ACTIVE" || profile.deletedAt) {
    // Do not leave a usable session behind for an account that cannot sign in.
    await db.auth.signOut();
    await recordLoginEvent({ eventType: "SIGN_IN_FAILED", userId: profile?.id ?? null, email: normalizedEmail, detail: "Account not active" });
    return { ok: false, reason: "inactive" };
  }

  // Bookkeeping nobody is waiting for. Started now, while the request (and its
  // headers, which the login event records) is still in scope, and finished
  // after the response, so signing in does not wait a round trip for it.
  const bookkeeping = Promise.all([
    adminDb.from("app_user").update({ lastLoginAt: new Date().toISOString() }).eq("id", profile.id),
    recordLoginEvent({ eventType: "SIGN_IN", userId: profile.id, email: normalizedEmail }),
  ]);
  after(() => bookkeeping.then(() => undefined, () => undefined));

  const pref = (Array.isArray(profile.preference) ? profile.preference[0] : profile.preference) as { startPage: string | null } | null;
  return { ok: true, userId: profile.id, startPage: pref?.startPage ?? null };
}

/** Ends the Supabase session, and any View as it had open. */
export async function signOut(): Promise<void> {
  const db = await supabaseSession();
  const { data: claims } = await db.auth.getClaims();
  const userId = (claims?.claims?.sub as string | undefined) ?? null;
  await endViewAs("Signed out").catch(() => {});
  await db.auth.signOut();
  if (userId) await recordLoginEvent({ eventType: "SIGN_OUT", userId, email: (claims?.claims?.email as string | undefined) ?? null });
}

/**
 * One line in the sign-in history. Best effort: a sign-in must never fail
 * because its history could not be written.
 */
export async function recordLoginEvent(event: {
  eventType: "SIGN_IN" | "SIGN_IN_FAILED" | "SIGN_OUT" | "VIEW_AS_START" | "VIEW_AS_END";
  userId?: string | null;
  email?: string | null;
  targetUserId?: string | null;
  reason?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0]?.trim() || null;
    // For a failed sign-in, whose account it was, if the address is one of ours.
    let userId = event.userId ?? null;
    if (!userId && event.email) {
      const { data } = await supabaseAdmin().from("app_user").select("id").ilike("email", event.email).maybeSingle();
      userId = (data?.id as string | undefined) ?? null;
    }
    await supabaseAdmin().from("login_event").insert({
      userId,
      email: event.email?.slice(0, 255) ?? null,
      eventType: event.eventType,
      targetUserId: event.targetUserId ?? null,
      reason: event.reason ?? null,
      ip: ip?.slice(0, 64) ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      detail: event.detail?.slice(0, 300) ?? null,
    });
  } catch {
    /* History is not worth a failed sign-in. */
  }
}
