"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { supabaseServer, supabaseAdmin, supabaseAnon } from "@/lib/supabase";
import { LIST_LIMIT } from "@/lib/db";
import { one, toDecimal, type Decimal } from "@/lib/decimal";
import { MEMBER_PUBLIC_COLUMNS } from "@/lib/rate-snapshots";
import { PERMISSIONS, authorize, requirePermission, requireUser, can } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { issuePasswordLink, passwordRules } from "@/lib/password-links";
import type { ActionResult } from "./partners";

/**
 * User administration.
 *
 * A user record is three things at once: a login, a profile, and a role. The
 * role is what the app actually enforces — `SecurityRole.permissions` and
 * `dataScope` are read on every request by src/lib/authz.ts — so changing
 * someone's role is the single act that changes what they can do.
 *
 * Two kinds of user exist:
 *   - **Employees** (Administrator, Resource, Manager, Finance…) — internal
 *     staff, optionally with cost and billing rates that drive project
 *     profitability and utilisation.
 *   - **Partners** — external people who must be tied to a Partner record via
 *     `partnerId`. That link is what a partner portal scopes everything
 *     through, so a partner user without it is refused.
 */

const PARTNER_ROLE = "Partner";

/**
 * Roles only the Super Admin hands out: Super Admin itself ('*'), CRM Admin,
 * and anything carrying a Super Admin permission. Without this a CRM Admin
 * could make themselves Super Admin from the user form.
 */
async function isTopRole(roleId: string | null | undefined): Promise<boolean> {
  if (!roleId) return false;
  const { data } = await supabaseAdmin().from("security_role").select("permissions").eq("id", roleId).maybeSingle();
  const permissions = (data?.permissions as string[] | undefined) ?? [];
  return permissions.some((p) => ["*", "all:except-delete", "record:delete", "role:manage"].includes(p));
}

async function isSuperAdminLogin(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("app_user").select("security_role ( permissions )").eq("id", userId).maybeSingle();
  const role = (Array.isArray(data?.security_role) ? data?.security_role[0] : data?.security_role) as { permissions?: string[] } | null;
  return Boolean(role?.permissions?.includes("*"));
}
const BCRYPT_ROUNDS = 10;

const userSchema = z.object({
  fullName: z.string().min(1).max(150),
  email: z.string().email().max(255),
  // Where notifications are delivered, when that differs from the sign-in
  // address. Empty string from an untouched form means "no override".
  notificationEmail: z
    .string()
    .email("Enter a valid email, or leave it empty.")
    .max(255)
    .optional()
    .nullable()
    .or(z.literal("")),
  employeeNumber: z.string().max(30).optional().nullable(),
  jobTitle: z.string().max(150).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  roleId: z.string().uuid(),
  departmentId: z.string().uuid().optional().nullable(),
  managerUserId: z.string().uuid().optional().nullable(),
  partnerId: z.string().uuid().optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).default("ACTIVE"),
  costRate: z.coerce.number().min(0).optional().nullable(),
  defaultBillingRate: z.coerce.number().min(0).optional().nullable(),
});

const createSchema = userSchema.extend({ password: passwordRules });

/**
 * Cross-field rules that depend on the chosen role. Kept in one place so
 * create and update cannot drift apart.
 */
async function validateAgainstRole(
  data: z.infer<typeof userSchema>,
  selfId?: string,
): Promise<ActionResult<never> | null> {
  const db = await supabaseServer();

  const { data: role } = await db
    .from("security_role")
    .select("name, active")
    .eq("id", data.roleId)
    .maybeSingle();

  if (!role?.active) return { ok: false, error: "Choose an active role.", fieldErrors: { roleId: ["Choose an active role."] } };

  if (data.departmentId) {
    const { data: department, error } = await db.from("department").select("id").eq("id", data.departmentId).eq("active", true).is("deletedAt", null).maybeSingle();
    if (error || !department) return { ok: false, error: "Choose an active department.", fieldErrors: { departmentId: ["Choose an active department."] } };
  }
  if (data.managerUserId) {
    const visited = new Set<string>(selfId ? [selfId] : []);
    let current: string | null = data.managerUserId;
    for (let depth = 0; current; depth++) {
      if (visited.has(current) || depth >= 100) return { ok: false, error: "This reporting line contains a cycle or is too deep. Choose another manager.", fieldErrors: { managerUserId: ["Invalid reporting line."] } };
      visited.add(current);
      const result = await db.from("app_user").select("id, managerUserId, status, deletedAt, partnerId").eq("id", current).maybeSingle();
      const manager = result.data as { id: string; managerUserId: string | null; status: string; deletedAt: string | null; partnerId: string | null } | null;
      const error = result.error;
      if (error || !manager || (depth === 0 && (manager.status !== "ACTIVE" || manager.deletedAt || manager.partnerId))) return { ok: false, error: "Choose an active internal manager.", fieldErrors: { managerUserId: ["Choose an active internal manager."] } };
      current = manager.managerUserId;
    }
  }

  if (role.name === PARTNER_ROLE) {
    if (data.departmentId || data.managerUserId || data.costRate != null || data.defaultBillingRate != null) return { ok: false, error: "Partner logins cannot have internal staffing assignments or rates." };
    if (!data.partnerId) {
      return {
        ok: false,
        error: "A partner user has to be linked to a partner record - that link is what their access is scoped through.",
        fieldErrors: { partnerId: ["Choose the partner this login belongs to."] },
      };
    }
    const { data: partner, error: partnerError } = await db.from("partner").select("id").eq("id", data.partnerId).is("deletedAt", null).maybeSingle();
    if (partnerError || !partner) return { ok: false, error: "Choose an existing partner." };
    let takenQuery = db
      .from("app_user")
      .select("fullName")
      .eq("partnerId", data.partnerId);

    if (selfId) takenQuery = takenQuery.neq("id", selfId);

    const { data: taken } = await takenQuery.limit(1).maybeSingle();
    if (taken) {
      return {
        ok: false,
        error: `${taken.fullName} already has the login for that partner. A partner gets one portal account.`,
        fieldErrors: { partnerId: ["Already taken."] },
      };
    }
  } else if (data.partnerId) {
    return {
      ok: false,
      error: "Only a user on the Partner role can be linked to a partner record.",
      fieldErrors: { partnerId: ["Clear this, or switch the role to Partner."] },
    };
  }

  return null;
}

export async function createUser(
  input: z.infer<typeof createSchema>,
): Promise<ActionResult<{ id: string; welcome: { emailedTo: string | null; emailError: string | null } }>> {
  const _auth = await authorize(PERMISSIONS.ADMIN);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { password, ...data } = parsed.data;

  if (!can(_auth.user, PERMISSIONS.ROLE_MANAGE) && (await isTopRole(data.roleId))) {
    return { ok: false, error: "Only the Super Admin can give someone the Super Admin or CRM Admin role.", fieldErrors: { roleId: ["Choose another role."] } };
  }

  const invalid = await validateAgainstRole(data);
  if (invalid) return invalid;

  try {
    const db = await supabaseServer();
    const email = data.email.toLowerCase();

    const { data: existing } = await db
      .from("app_user")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      return {
        ok: false,
        error: "Someone already uses that email address.",
        fieldErrors: { email: ["Already registered."] },
      };
    }

    // Sign-in needs BOTH halves of the identity, so both are written here.
    //
    // NextAuth checks the bcrypt hash on app_user, then signs the same
    // credentials in to Supabase Auth so the request carries a JWT and RLS
    // lets the user read anything (src/lib/auth.ts). A user created with only
    // the app_user row passes the first check and fails the second, so the
    // account exists, looks correct in the admin screens, and cannot log in.
    // That is exactly what happened to every user added through this form.
    //
    // The auth user is created FIRST and its id reused as the app_user id.
    // Everything downstream — ownerUserId, RLS's app_visible_owner_ids(),
    // audit trails — assumes auth.users.id === app_user.id, and generating
    // two different ids is the failure scripts/migrate-auth-users.mjs had to
    // repair by hand once already.
    const auth = supabaseAdmin();

    const { data: created, error: authError } = await auth.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // No inbox round-trip: an admin created this account.
      user_metadata: { fullName: data.fullName },
    });

    if (authError || !created?.user) {
      return {
        ok: false,
        error: `Could not create the sign-in account: ${authError?.message ?? "unknown error"}`,
        fieldErrors: /already/i.test(authError?.message ?? "")
          ? { email: ["Already registered."] }
          : undefined,
      };
    }

    try {
      // ADMIN was checked above. The generic invoker RPC returns all columns,
      // which authenticated clients cannot read after rate-column hardening.
      // Keep privileged access on this fixed table and return only the ID.
      const { data: user, error: profileError } = await auth.from("app_user").insert({
        ...data,
        id: created.user.id,
        email,
        notificationEmail: data.notificationEmail || null,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        updatedAt: new Date().toISOString(),
      }).select("id").single();
      if (profileError) throw new Error(profileError.message);

      // A link to choose their own password, so nobody has to pass the
      // temporary one on. Best effort: a failed email never undoes the login.
      const welcome = await issuePasswordLink({ userId: user.id, purpose: "WELCOME", createdBy: _auth.user })
        .then((l) => ({ emailedTo: l.emailedTo, emailError: l.emailError }))
        .catch((e: unknown) => ({ emailedTo: null, emailError: e instanceof Error ? e.message : "Could not send the welcome email." }));

      revalidatePath("/users");
      return { ok: true, data: { id: user.id, welcome } };
    } catch (profileError) {
      // The profile insert failed after the auth user was created. Leaving it
      // behind would block the email forever with an account nobody can see or
      // administer, so it is removed before the error is reported.
      await auth.auth.admin.deleteUser(created.user.id).catch(() => {});
      throw profileError;
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the user." };
  }
}

export async function updateUser(
  id: string,
  input: z.infer<typeof userSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.ADMIN);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const actor = _auth.user;

  const parsed = userSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: describeInvalid(parsed.error), fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;

  if (!can(actor, PERMISSIONS.ROLE_MANAGE)) {
    if (await isSuperAdminLogin(id)) return { ok: false, error: "Only the Super Admin can change the Super Admin's login." };
    const { data: current } = await supabaseAdmin().from("app_user").select("roleId").eq("id", id).maybeSingle();
    if (current?.roleId !== data.roleId && ((await isTopRole(data.roleId)) || (await isTopRole(current?.roleId as string | null)))) {
      return { ok: false, error: "Only the Super Admin can give or take away the Super Admin or CRM Admin role.", fieldErrors: { roleId: ["Ask the Super Admin."] } };
    }
  }

  const invalid = await validateAgainstRole(data, id);
  if (invalid) return invalid;

  try {
    const email = data.email.toLowerCase();
    const db = await supabaseServer();

    const { data: clash } = await db
      .from("app_user")
      .select("id")
      .eq("email", email)
      .neq("id", id)
      .limit(1)
      .maybeSingle();
    if (clash) {
      return {
        ok: false,
        error: "Someone already uses that email address.",
        fieldErrors: { email: ["Already registered."] },
      };
    }

    const { data: before } = await db
      .from("app_user")
      .select("roleId, status")
      .eq("id", id)
      .maybeSingle();

    if (!before) return { ok: false, error: "User not found." };

    // Locking yourself out, or demoting the last administrator, are both easy
    // accidents with no way back through the UI.
    if (id === actor.id && data.status !== "ACTIVE") {
      return { ok: false, error: "You cannot deactivate your own account." };
    }

    if (before.roleId !== data.roleId || before.status !== data.status) {
      const { data: adminRole } = await db
        .from("security_role")
        .select("id")
        .contains("permissions", ["*"])
        .limit(1)
        .maybeSingle();

      if (adminRole && before.roleId === adminRole.id) {
        const { count: remaining } = await db
          .from("app_user")
          .select("id", { count: "exact", head: true })
          .eq("roleId", adminRole.id)
          .eq("status", "ACTIVE")
          .is("deletedAt", null)
          .neq("id", id);

        const stillAdmin = data.roleId === adminRole.id && data.status === "ACTIVE";
        if ((remaining ?? 0) === 0 && !stillAdmin) {
          return {
            ok: false,
            error:
              "This is the last active administrator. Promote someone else before changing this account.",
          };
        }
      }
    }

    // A manager cannot report to themselves, directly or in a short cycle.
    if (data.managerUserId === id) {
      return { ok: false, error: "Someone cannot be their own manager." };
    }

    // Sign-in looks the account up by email in BOTH stores, so a change here
    // has to reach Supabase Auth as well or the user is locked out under their
    // new address while the old one no longer matches a profile.
    const { data: current } = await db
      .from("app_user")
      .select("email")
      .eq("id", id)
      .maybeSingle();

    if (current && current.email !== email) {
      const { error: authError } = await supabaseAdmin().auth.admin.updateUserById(id, {
        email,
        email_confirm: true,
      });

      if (authError) {
        return { ok: false, error: `Could not update the sign-in address: ${authError.message}` };
      }
    }

    // An empty field means "no override", which is null rather than "" — an
    // empty string would read as a real address and send mail nowhere.
    // Preserve atomic audit history while keeping protected columns server-only.
    // Table and actor are fixed here, after ADMIN authorization and validation.
    const { error: updateError } = await supabaseAdmin().rpc("update_record", {
      p_table: "app_user", p_id: id,
      p_payload: { ...data, email, notificationEmail: data.notificationEmail || null },
      p_entity_type: "User", p_actor_id: actor.id,
    });
    if (updateError) throw new Error(updateError.message);

    revalidatePath("/users");
    revalidatePath(`/users/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update the user." };
  }
}

/** Administrator resets someone's password. */
export async function setUserPassword(id: string, password: string): Promise<ActionResult> {
  const _auth = await authorize(PERMISSIONS.ADMIN);
  if (!_auth.ok) return { ok: false, error: _auth.error };
  if (!can(_auth.user, PERMISSIONS.ROLE_MANAGE) && (await isSuperAdminLogin(id))) {
    return { ok: false, error: "Only the Super Admin can reset the Super Admin's password." };
  }
  const actor = _auth.user;

  const parsed = passwordRules.safeParse(password);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That password is too weak.",
      fieldErrors: { password: parsed.error.issues.map((i) => i.message) },
    };
  }

  try {
    const db = await supabaseServer();

    const { data: user } = await db
      .from("app_user")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (!user) return { ok: false, error: "User not found." };

    // Both stores hold the password, so both are updated. Changing only the
    // bcrypt hash leaves NextAuth accepting the new password and Supabase Auth
    // still expecting the old one, and sign-in fails at the second step — the
    // reset appears to work and locks the user out instead.
    const { error: authError } = await supabaseAdmin().auth.admin.updateUserById(
      user.id,
      { password: parsed.data },
    );

    if (authError) {
      return { ok: false, error: `Could not update the sign-in password: ${authError.message}` };
    }

    const { error } = await db
      .from("app_user")
      .update({
        passwordHash: await bcrypt.hash(parsed.data, BCRYPT_ROUNDS),
        updatedAt: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (error) throw new Error(error.message);

    // The hash itself is never recorded — only that a reset happened.
    await writeAudit({
      entityType: "User",
      entityId: id,
      fieldName: "passwordHash",
      oldValue: null,
      newValue: "reset",
      changedById: actor.id,
    });

    revalidatePath(`/users/${id}`);
    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not set the password." };
  }
}

/** Lets the signed-in user change their own password. */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<ActionResult> {
  const _auth = await authorize();
  if (!_auth.ok) return { ok: false, error: _auth.error };
  const actor = _auth.user;

  const parsed = passwordRules.safeParse(newPassword);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That password is too weak.",
      fieldErrors: { newPassword: parsed.error.issues.map((i) => i.message) },
    };
  }

  try {
    const db = await supabaseServer();

    // The current password is checked against Supabase Auth, which is what
    // actually guards sign-in. This used to bcrypt.compare() against
    // app_user.passwordHash, but that column is dead since the move to Supabase
    // Auth and was revoked from `authenticated` in
    // 20260902000000_hide_rate_columns.sql — the read came back empty and every
    // password change failed as "that is not your current password".
    //
    // signInWithPassword on a throwaway client, so a wrong password cannot
    // disturb the session the caller is currently holding.
    const verify = supabaseAnon();
    const { error: verifyError } = await verify.auth.signInWithPassword({
      email: actor.email,
      password: currentPassword,
    });
    await verify.auth.signOut();

    if (verifyError) {
      return {
        ok: false,
        error: "That is not your current password.",
        fieldErrors: { currentPassword: ["Incorrect."] },
      };
    }

    // Supabase Auth first, for the same reason as the admin reset above: if
    // only the bcrypt hash moves, the next sign-in passes the NextAuth check
    // and is then rejected by Supabase, locking the user out of their own
    // account with a password they just set themselves.
    const { error: authError } = await supabaseAdmin().auth.admin.updateUserById(
      actor.id,
      { password: parsed.data },
    );

    if (authError) {
      return { ok: false, error: `Could not update your sign-in password: ${authError.message}` };
    }

    // passwordHash is deliberately not written. Supabase Auth above holds the
    // real credential; mirroring it into a revoked, unread column would only
    // keep a second copy of a secret nothing checks.
    const { error } = await db
      .from("app_user")
      .update({ updatedAt: new Date().toISOString() })
      .eq("id", actor.id);

    if (error) throw new Error(error.message);

    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not change your password." };
  }
}

export async function listUsers(filters?: { search?: string; roleId?: string; status?: string }) {
  await requirePermission(PERMISSIONS.ADMIN);

  // Service role, because this selects `*` and app_user no longer grants every
  // column to `authenticated`: costRate, defaultBillingRate and passwordHash
  // were revoked in 20260902000000_hide_rate_columns.sql, and Postgres fails a
  // `SELECT *` that reaches a column the role cannot read. The rates are not
  // incidental here — the page counts people missing them — so the fix is to
  // read them with authority rather than to drop them from the select.
  //
  // Not a wider door: requirePermission(ADMIN) above already gates this, and
  // user administration is exactly the screen allowed to see pay rates.
  const db = supabaseAdmin();

  // projectMemberships selects ids rather than using count(): project_member
  // has had no table-level SELECT grant since 20260918000003, which is what
  // PostgREST's count() needs. The rows are counted in rowsOf below.
  let query = db
    .from("app_user")
    .select(
      `*,
       role:security_role ( id, name, dataScope, permissions ),
       department:app_user_departmentId_fkey ( id, name ),
       manager:managerUserId ( id, fullName ),
       partner:app_user_partnerId_fkey ( id, partnerNumber, displayName ),
       projectMemberships:project_member ( id ),
       ownedAccounts:account!account_ownerUserId_fkey ( count ),
       assignedTasks:project_task!project_task_assignedUserId_fkey ( count )`,
    )
    .is("deletedAt", null)
    .order("status")
    .order("fullName");

  if (filters?.roleId) query = query.eq("roleId", filters.roleId);
  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.search) {
    const s = filters.search.replace(/[,()]/g, "");
    query = query.or(
      `fullName.ilike.%${s}%,email.ilike.%${s}%,employeeNumber.ilike.%${s}%`,
    );
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load users: ${error.message}`);

  const countOf = (v: unknown) => (v as { count: number }[] | undefined)?.[0]?.count ?? 0;
  /** For embeds returned as rows rather than an aggregate. */
  const rowsOf = (v: unknown) => (Array.isArray(v) ? v.length : 0);

  return (data ?? []).map((u) => ({
    ...u,
    role: one(u.role as never),
    department: one(u.department as never),
    manager: one(u.manager as never),
    partner: one(u.partner as never),
    _count: {
      projectMemberships: rowsOf(u.projectMemberships),
      ownedAccounts: countOf(u.ownedAccounts),
      assignedTasks: countOf(u.assignedTasks),
    },
  }));
}

export async function getUser(id: string) {
  await requirePermission(PERMISSIONS.ADMIN);

  // Same reason as listUsers: `*` over a table whose rate columns are revoked
  // from `authenticated`, behind the same ADMIN gate.
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("app_user")
    .select(
      `*,
       role:security_role ( * ),
       department:app_user_departmentId_fkey ( id, name ),
       manager:managerUserId ( id, fullName ),
       partner:app_user_partnerId_fkey ( id, partnerNumber, displayName ),
       teamMemberships:team_member ( *, team ( id, name ) ),
       projectMemberships:project_member (
         ${MEMBER_PUBLIC_COLUMNS},
         project ( id, name, projectNumber, status )
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  // 22P02 is Postgres rejecting the id in the URL as not a uuid at all.
  // Someone typing /users/banana has asked for a record that cannot exist,
  // which is a 404 — not a server fault worth an error page.
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load user: ${error.message}`);
  }
  if (!data) return null;

  // PostgREST cannot embed the reverse side of a self-referencing FK
  // (app_user.managerUserId -> app_user.id), so direct reports are a second query.
  const { data: reports } = await db
    .from("app_user")
    .select("id, fullName, jobTitle, status")
    .eq("managerUserId", id)
    .is("deletedAt", null);

  return {
    ...data,
    role: one(data.role as never),
    department: one(data.department as never),
    manager: one(data.manager as never),
    partner: one(data.partner as never),
    reports: reports ?? [],
    teamMemberships: ((data.teamMemberships ?? []) as Record<string, unknown>[]).map(
      (m) => ({ ...m, team: one(m.team as never) }),
    ),
    // Prisma filtered the memberships in the query; PostgREST returns them all.
    projectMemberships: ((data.projectMemberships ?? []) as Record<string, unknown>[])
      .filter((m) => m.active)
      .map((m) => ({ ...m, project: one(m.project as never) })),
  };
}

export async function getUserFormOptions() {
  await requirePermission(PERMISSIONS.ADMIN);

  const db = await supabaseServer();

  const [rolesRes, departmentsRes, managersRes, partnersRes, takenRes] =
    await Promise.all([
      db
        .from("security_role")
        .select("id, name, description, dataScope, permissions")
        .eq("active", true)
        // The portal roles are not offered here: an external login is created
        // from the partner's page or the contact's, which is also where its
        // welcome email and its link to a person come from.
        .not("name", "in", '("Partner","Customer")')
        .order("name"),
      db
        .from("department")
        .select("id, name")
        .is("deletedAt", null)
        .eq("active", true)
        .order("name"),
      db
        .from("app_user")
        .select("id, fullName, jobTitle")
        .eq("status", "ACTIVE")
        .is("deletedAt", null)
        .is("partnerId", null)
        .order("fullName"),
      db
        .from("partner")
        .select("id, partnerNumber, displayName, kind")
        .is("deletedAt", null)
        .order("displayName"),
      // Prisma expressed "no portal login yet" as `portalUser: null`. PostgREST
      // has no not-exists filter on an embedded relation, so the partner ids
      // that already have a login are fetched and excluded below.
      db.from("app_user").select("partnerId").not("partnerId", "is", null),
    ]);

  const taken = new Set((takenRes.data ?? []).map((u) => u.partnerId));

  return {
    roles: rolesRes.data ?? [],
    departments: departmentsRes.data ?? [],
    managers: managersRes.data ?? [],
    // One portal account per partner.
    partners: (partnersRes.data ?? []).filter((p) => !taken.has(p.id)),
  };
}

/** All partners, including those already holding a login — for the edit form. */
export async function getAllPartners() {
  await requirePermission(PERMISSIONS.ADMIN);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("partner")
    .select("id, partnerNumber, displayName, kind")
    .is("deletedAt", null)
    .order("displayName");

  if (error) throw new Error(`Could not load partners: ${error.message}`);
  return data ?? [];
}

/**
 * The caller's own place in the reporting line, for the user guide.
 *
 * Needs no permission beyond a session: it describes only the reader's own
 * position, and the names it returns are people whose records they can already
 * see under DEPARTMENT scope.
 *
 * `reportsBelow` walks the whole sub-tree, not just direct reports, because
 * that is what DEPARTMENT scope actually grants — telling someone they see
 * "3 reports" when the walk reaches 8 people would be misleading.
 */
export async function getMyReportingLine() {
  const me = await requireUser();
  const db = supabaseAdmin();

  const { data: staff } = await db
    .from("app_user")
    .select("id, fullName, managerUserId")
    .is("deletedAt", null);

  const everyone = staff ?? [];
  const manager = everyone.find(
    (u) => u.id === everyone.find((x) => x.id === me.id)?.managerUserId,
  );

  const directReports = everyone.filter((u) => u.managerUserId === me.id);

  // Same cycle-safe walk as scopeFilter, so the count cannot disagree with it.
  const below = new Set<string>();
  const queue = [me.id];
  const seen = new Set<string>([me.id]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of everyone.filter((u) => u.managerUserId === current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      below.add(child.id);
      queue.push(child.id);
    }
  }

  return {
    managerName: manager?.fullName ?? null,
    directReports: directReports.map((r) => r.fullName),
    totalBelow: below.size,
  };
}

/**
 * One person's workload, for the delivery panel on their user page.
 *
 * The rest of the user page answers "what is this account allowed to do". This
 * answers "what is this person actually doing" — where their hours go, what
 * they have open, what they have finished, and whether the work lands when it
 * was promised.
 *
 * The day/week/month/all-time split is the shape a manager asks in: "did they
 * log today", "are they on track this week", "what did the month come to". The
 * totals are deliberately unbounded rather than windowed, because a record of
 * finished work is only useful if it does not quietly expire.
 *
 * Nothing here is forecast. Every figure is arithmetic over recorded rows, and
 * the counts behind each ratio are returned alongside it so a percentage drawn
 * from two tasks can be recognised as the noise it is rather than read as a
 * verdict on someone. See getResourceDetail in ./timesheets.ts, which answers
 * the same question for the staffing view and uses the same definitions.
 */
export async function getUserWorkload(userId: string) {
  // The user page is ADMIN-gated and this is part of it. It exposes one
  // person's hours, rates and delivery record, so it must not be reachable on
  // anything weaker than the page that renders it.
  await requirePermission(PERMISSIONS.ADMIN);

  const db = supabaseAdmin();

  const now = new Date();
  const todayDay = now.toISOString().slice(0, 10);

  // Monday-based, matching weekBounds() in ./timesheets.ts. Using a different
  // week boundary here would make this panel disagree with the timesheet
  // screens about what "this week" means.
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weekStartDay = weekStart.toISOString().slice(0, 10);

  const monthStartDay = `${now.toISOString().slice(0, 7)}-01`;

  // 30 days of daily bars, so the rhythm of someone's logging is visible —
  // a steady four hours a day and one frantic Friday both average the same.
  const trendFrom = new Date(now);
  trendFrom.setDate(trendFrom.getDate() - 29);
  const trendFromDay = trendFrom.toISOString().slice(0, 10);

  const [logsRes, tasksRes, casesRes] = await Promise.all([
    // Every entry this person has logged, not a window: the "total" figures and
    // per-task actuals are only meaningful over their whole history. The cap is
    // a safety limit, not a filter.
    db
      .from("time_log")
      .select(
        `hours, billable, workDate, approvalStatus, billingRate, costRate,
         projectId, projectTaskId, caseId,
         project ( id, name, projectNumber ),
         task:project_task ( id, name )`,
      )
      .eq("userId", userId)
      .order("workDate", { ascending: false })
      .limit(5000),

    db
      .from("project_task")
      .select(
        `id, name, status, priority, dueDate, completedDate, estimatedHours,
         completionPercent, projectId,
         project ( id, name, projectNumber )`,
      )
      .eq("assignedUserId", userId)
      .limit(1000),

    db
      .from("support_case")
      .select(
        `id, caseNumber, subject, status, priority, slaBreached, reopenCount,
         satisfactionScore, firstResponseDueAt, firstRespondedAt,
         resolutionDueAt, resolvedAt, closedAt, createdAt,
         account ( id, name )`,
      )
      .eq("ownerUserId", userId)
      .is("deletedAt", null)
      .limit(1000),
  ]);

  // A broken query and an empty result are different things. Letting a failed
  // select fall through as "no work logged" would quietly paint someone as idle.
  for (const [what, res] of [
    ["time logs", logsRes],
    ["tasks", tasksRes],
    ["cases", casesRes],
  ] as const) {
    if (res.error) {
      throw new Error(`Could not load ${what} for user ${userId}: ${res.error.message}`);
    }
  }

  const allLogs = (logsRes.data ?? []).map((l) => ({
    ...l,
    project: one(l.project as never) as unknown as
      { id: string; name: string; projectNumber: string } | null,
    task: one(l.task as never) as unknown as { id: string; name: string } | null,
  }));

  // Rejected time is excluded from every hours figure — it is work the business
  // decided not to count — but kept in `allLogs` so the rejection rate below can
  // be measured against everything submitted.
  const counted = allLogs.filter((l) => l.approvalStatus !== "REJECTED");

  const sumHours = (rows: typeof counted) =>
    rows.reduce((acc, l) => acc.plus(toDecimal(l.hours)), toDecimal(0));

  const period = (rows: typeof counted) => {
    const billableRows = rows.filter((l) => l.billable);
    const logged = sumHours(rows);
    const billable = sumHours(billableRows);
    return {
      logged,
      billable,
      nonBillable: logged.minus(billable),
      entries: rows.length,
      billableRatioPercent: logged.isZero()
        ? 0
        : Number(billable.dividedBy(logged).times(100).toDecimalPlaces(1)),
    };
  };

  const today = counted.filter((l) => String(l.workDate) === todayDay);
  const thisWeek = counted.filter((l) => String(l.workDate) >= weekStartDay);
  const thisMonth = counted.filter((l) => String(l.workDate) >= monthStartDay);

  // --- Daily trend ---------------------------------------------------------
  const byDay = new Map<string, { hours: Decimal; billable: Decimal }>();
  for (const l of counted) {
    const d = String(l.workDate);
    if (d < trendFromDay) continue;
    const acc = byDay.get(d) ?? { hours: toDecimal(0), billable: toDecimal(0) };
    acc.hours = acc.hours.plus(toDecimal(l.hours));
    if (l.billable) acc.billable = acc.billable.plus(toDecimal(l.hours));
    byDay.set(d, acc);
  }
  const daily: { day: string; hours: number; billableHours: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDay.get(key);
    daily.push({
      day: key,
      hours: Number((v?.hours ?? toDecimal(0)).toDecimalPlaces(2)),
      billableHours: Number((v?.billable ?? toDecimal(0)).toDecimalPlaces(2)),
    });
  }

  // --- Tasks ---------------------------------------------------------------
  const OPEN_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "UNDER_REVIEW"];
  const tasks = (tasksRes.data ?? []).map((t) => ({
    ...t,
    project: one(t.project as never) as unknown as
      { id: string; name: string; projectNumber: string } | null,
  }));

  const openTasks = tasks.filter((t) => OPEN_STATUSES.includes(String(t.status)));
  const completedTasks = tasks.filter((t) => t.status === "COMPLETED");
  const cancelledTasks = tasks.filter((t) => t.status === "CANCELLED");
  const overdueTasks = openTasks.filter((t) => t.dueDate && String(t.dueDate) < todayDay);
  const blockedTasks = openTasks.filter((t) => t.status === "BLOCKED");
  const dueThisWeek = openTasks.filter(
    (t) => t.dueDate && String(t.dueDate) >= todayDay && String(t.dueDate) <= addDays(todayDay, 7),
  );

  // Hours actually booked against each task, for the "on which task" view and
  // for estimate accuracy.
  const hoursByTask = new Map<string, Decimal>();
  for (const l of counted) {
    if (!l.projectTaskId) continue;
    const key = String(l.projectTaskId);
    hoursByTask.set(key, (hoursByTask.get(key) ?? toDecimal(0)).plus(toDecimal(l.hours)));
  }

  // On-time delivery can only be judged on tasks that carried a due date, so
  // that is the denominator — counting every completed task would quietly
  // reward leaving dates off.
  const datedCompleted = completedTasks.filter((t) => t.dueDate && t.completedDate);
  const onTime = datedCompleted.filter((t) => String(t.completedDate) <= String(t.dueDate));

  const estimated = completedTasks
    .map((t) => ({
      task: t,
      estimate: toDecimal(t.estimatedHours ?? 0),
      actual: hoursByTask.get(String(t.id)) ?? toDecimal(0),
    }))
    .filter((e) => e.estimate.greaterThan(0) && e.actual.greaterThan(0));
  const totalEstimate = estimated.reduce((a, e) => a.plus(e.estimate), toDecimal(0));
  const totalActual = estimated.reduce((a, e) => a.plus(e.actual), toDecimal(0));

  // Average completion across open work: "how far through is what they hold".
  const avgProgress =
    openTasks.length === 0
      ? 0
      : Number(
          openTasks
            .reduce((a, t) => a.plus(toDecimal(t.completionPercent ?? 0)), toDecimal(0))
            .dividedBy(openTasks.length)
            .toDecimalPlaces(0),
        );

  // Remaining effort on open work, from each task's own estimate less what has
  // already gone into it. Negative overruns are floored at zero: work already
  // past its estimate has no negative time left to give.
  const remainingHours = openTasks.reduce((acc, t) => {
    const est = toDecimal(t.estimatedHours ?? 0);
    if (est.isZero()) return acc;
    const spent = hoursByTask.get(String(t.id)) ?? toDecimal(0);
    const left = est.minus(spent);
    return acc.plus(left.greaterThan(0) ? left : toDecimal(0));
  }, toDecimal(0));

  // --- Cases ---------------------------------------------------------------
  const CLOSED_CASE_STATUSES = ["RESOLVED", "CLOSED", "CANCELLED"];
  const cases = (casesRes.data ?? []).map((c) => ({
    ...c,
    account: one(c.account as never) as unknown as { id: string; name: string } | null,
  }));
  const openCases = cases.filter((c) => !CLOSED_CASE_STATUSES.includes(String(c.status)));
  const closedCases = cases.filter((c) => CLOSED_CASE_STATUSES.includes(String(c.status)));
  const breachedCases = cases.filter((c) => c.slaBreached);
  const reopenedCases = cases.filter((c) => Number(c.reopenCount ?? 0) > 0);
  const overdueCases = openCases.filter(
    (c) => c.resolutionDueAt && new Date(String(c.resolutionDueAt)) < now,
  );

  const scored = cases.filter((c) => c.satisfactionScore != null);
  const avgSatisfaction =
    scored.length === 0
      ? null
      : Number(
          scored
            .reduce((a, c) => a.plus(toDecimal(c.satisfactionScore)), toDecimal(0))
            .dividedBy(scored.length)
            .toDecimalPlaces(1),
        );

  // Median, not mean: one case left open over a holiday would drag an average
  // far enough to misrepresent every other case the person handled.
  const resolutionHours = closedCases
    .filter((c) => c.resolvedAt)
    .map(
      (c) =>
        (new Date(String(c.resolvedAt)).getTime() - new Date(String(c.createdAt)).getTime()) /
        3_600_000,
    )
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const medianResolutionHours =
    resolutionHours.length === 0
      ? null
      : Number(resolutionHours[Math.floor(resolutionHours.length / 2)].toFixed(1));

  // --- Money ---------------------------------------------------------------
  // From the rates stamped on each entry, not the person's current rate card,
  // so a re-rate cannot rewrite what past work earned.
  const revenue = counted
    .filter((l) => l.billable)
    .reduce((a, l) => a.plus(toDecimal(l.hours).times(toDecimal(l.billingRate ?? 0))), toDecimal(0));
  const cost = counted.reduce(
    (a, l) => a.plus(toDecimal(l.hours).times(toDecimal(l.costRate ?? 0))),
    toDecimal(0),
  );

  // --- Where the hours went ------------------------------------------------
  const taskRows = [...hoursByTask.entries()]
    .map(([taskId, hours]) => {
      const t = tasks.find((x) => String(x.id) === taskId);
      const logged = allLogs.find((l) => String(l.projectTaskId) === taskId);
      const estimate = toDecimal(t?.estimatedHours ?? 0);
      return {
        id: taskId,
        name: t?.name ?? logged?.task?.name ?? "(task no longer assigned to them)",
        status: t?.status ?? null,
        project: t?.project ?? logged?.project ?? null,
        hours: Number(hours.toDecimalPlaces(1)),
        estimatedHours: estimate.isZero() ? null : Number(estimate.toDecimalPlaces(1)),
        overrunPercent: estimate.isZero()
          ? null
          : Number(hours.minus(estimate).dividedBy(estimate).times(100).toDecimalPlaces(0)),
      };
    })
    .sort((a, b) => b.hours - a.hours);

  const projectMap = new Map<string, { name: string; number: string; hours: Decimal }>();
  for (const l of counted) {
    if (!l.project) continue;
    const acc =
      projectMap.get(l.project.id) ??
      { name: l.project.name, number: l.project.projectNumber, hours: toDecimal(0) };
    acc.hours = acc.hours.plus(toDecimal(l.hours));
    projectMap.set(l.project.id, acc);
  }
  const projectRows = [...projectMap.entries()]
    .map(([id, v]) => ({ id, name: v.name, number: v.number, hours: Number(v.hours.toDecimalPlaces(1)) }))
    .sort((a, b) => b.hours - a.hours);

  const totals = period(counted);
  const lastEntry = counted[0]?.workDate ? String(counted[0].workDate) : null;

  return {
    time: {
      today: period(today),
      week: period(thisWeek),
      month: period(thisMonth),
      total: totals,
      /** The most recent day they logged anything — how current their timesheet is. */
      lastEntryDay: lastEntry,
      daysSinceLastEntry: lastEntry ? daysApart(lastEntry, todayDay) : null,
      weekStartDay,
      monthStartDay,
    },

    // A 40-hour week is the same yardstick the resources report uses.
    utilisation: {
      weekPercent: Number(
        period(thisWeek).logged.dividedBy(40).times(100).toDecimalPlaces(1),
      ),
      weekBillablePercent: Number(
        period(thisWeek).billable.dividedBy(40).times(100).toDecimalPlaces(1),
      ),
      monthPercent: (() => {
        // Working days elapsed this month, so early in a month the figure is
        // not a fiction built on days that have not happened yet.
        const days = workingDaysBetween(monthStartDay, todayDay);
        const capacity = toDecimal(days * 8);
        return capacity.isZero()
          ? 0
          : Number(period(thisMonth).logged.dividedBy(capacity).times(100).toDecimalPlaces(1));
      })(),
      monthWorkingDaysElapsed: workingDaysBetween(monthStartDay, todayDay),
    },

    tasks: {
      open: openTasks.length,
      completed: completedTasks.length,
      cancelled: cancelledTasks.length,
      overdue: overdueTasks.length,
      blocked: blockedTasks.length,
      dueThisWeek: dueThisWeek.length,
      total: tasks.length,
      avgProgressPercent: avgProgress,
      remainingHours,
      onTimePercent:
        datedCompleted.length === 0
          ? null
          : Math.round((onTime.length / datedCompleted.length) * 100),
      datedCompletedCount: datedCompleted.length,
      upcoming: openTasks
        .slice()
        .sort((a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")))
        .slice(0, 10)
        .map((t) => ({
          id: String(t.id),
          name: String(t.name),
          status: String(t.status),
          priority: String(t.priority),
          dueDate: t.dueDate ? String(t.dueDate) : null,
          completionPercent: Number(t.completionPercent ?? 0),
          project: t.project,
          hoursSpent: Number((hoursByTask.get(String(t.id)) ?? toDecimal(0)).toDecimalPlaces(1)),
          estimatedHours: t.estimatedHours ? Number(t.estimatedHours) : null,
          overdue: Boolean(t.dueDate && String(t.dueDate) < todayDay),
        })),
    },

    estimates: {
      /** >100 means the work ran over its estimate. Null when nothing qualifies. */
      accuracyPercent: totalEstimate.isZero()
        ? null
        : Number(totalActual.dividedBy(totalEstimate).times(100).toDecimalPlaces(0)),
      /** How many completed tasks this rests on — the trust signal. */
      sampleSize: estimated.length,
      estimatedHours: totalEstimate,
      actualHours: totalActual,
    },

    cases: {
      open: openCases.length,
      closed: closedCases.length,
      total: cases.length,
      overdue: overdueCases.length,
      breached: breachedCases.length,
      reopened: reopenedCases.length,
      medianResolutionHours,
      avgSatisfaction,
      satisfactionCount: scored.length,
      openList: openCases
        .slice()
        .sort((a, b) =>
          String(a.resolutionDueAt ?? "9999").localeCompare(String(b.resolutionDueAt ?? "9999")),
        )
        .slice(0, 8)
        .map((c) => ({
          id: String(c.id),
          caseNumber: String(c.caseNumber),
          subject: String(c.subject),
          status: String(c.status),
          priority: String(c.priority),
          account: c.account,
          dueAt: c.resolutionDueAt ? String(c.resolutionDueAt) : null,
          breached: Boolean(c.slaBreached),
          overdue: Boolean(c.resolutionDueAt && new Date(String(c.resolutionDueAt)) < now),
        })),
    },

    money: {
      revenue,
      cost,
      profit: revenue.minus(cost),
      marginPercent: revenue.isZero()
        ? 0
        : Number(revenue.minus(cost).dividedBy(revenue).times(100).toDecimalPlaces(1)),
    },

    quality: {
      entries: allLogs.length,
      rejectedEntries: allLogs.filter((l) => l.approvalStatus === "REJECTED").length,
      rejectedPercent:
        allLogs.length === 0
          ? 0
          : Number(
              ((allLogs.filter((l) => l.approvalStatus === "REJECTED").length / allLogs.length) *
                100).toFixed(1),
            ),
      unsubmittedHours: sumHours(allLogs.filter((l) => l.approvalStatus === "DRAFT")),
      awaitingApprovalHours: sumHours(allLogs.filter((l) => l.approvalStatus === "SUBMITTED")),
    },

    daily,
    byTask: taskRows.slice(0, 10),
    byProject: projectRows,
  };
}

/** `yyyy-mm-dd` plus n days, staying in date-only space. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two `yyyy-mm-dd` dates. */
function daysApart(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Working days from `from` to `to` inclusive, weekends excluded.
 *
 * Public holidays are not modelled anywhere in this system, so this is
 * deliberately a simple Mon-Fri count rather than a false precision.
 */
function workingDaysBetween(from: string, to: string): number {
  let count = 0;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}
