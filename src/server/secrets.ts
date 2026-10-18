"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { supabaseServer } from "@/lib/supabase";
import { createRecord, updateRecord, applySearch, LIST_LIMIT } from "@/lib/db";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import type { ActionResult } from "./partners";
import {
  encryptSecret,
  decryptSecret,
  valueHint,
  vaultKeyConfigured,
} from "@/lib/secret-crypto";
import { envKeys, parseEnvFile } from "@/lib/env-file";

/**
 * The credential vault.
 *
 * Two rules run through everything here:
 *
 *   1. A stored value leaves the server only through revealSecret(), and every
 *      call to it writes an access log row. Nothing else in this module returns
 *      a decrypted value, and no list or detail query selects the ciphertext —
 *      so a plaintext credential cannot reach the browser as a side effect of
 *      rendering a page.
 *
 *   2. Reading the vault and changing it are separate permissions, and neither
 *      is implied by admin. See PERMISSIONS.SECRET_READ / SECRET_WRITE.
 */

const KINDS = [
  "API_KEY", "PASSWORD", "EMAIL_ACCOUNT", "DATABASE", "CERTIFICATE",
  "SSH_KEY", "WEBHOOK_SECRET", "TOKEN", "ENV_FILE", "OTHER",
] as const;

/** A whole .env file is bigger than a key, but not unbounded. */
const MAX_VALUE_LENGTH = 100_000;

const ENVIRONMENTS = ["PRODUCTION", "STAGING", "DEVELOPMENT", "SHARED"] as const;
const STATUSES = ["ACTIVE", "ROTATING", "REVOKED"] as const;

const secretSchema = z.object({
  name: z.string().min(1).max(255),
  service: z.string().min(1).max(255),
  kind: z.enum(KINDS).default("API_KEY"),
  environment: z.enum(ENVIRONMENTS).default("PRODUCTION"),
  status: z.enum(STATUSES).default("ACTIVE"),
  username: z.string().max(255).optional().nullable(),
  url: z.string().optional().nullable(),
  ownerUserId: z.string().uuid(),
  // Empty means BabulTech Internal: company-wide, no particular project.
  projectId: z.string().uuid().optional().nullable().or(z.literal("")),
  expiresAt: z.string().optional().nullable(),
  rotationDays: z.coerce.number().int().positive().optional().nullable(),
  lastRotatedAt: z.string().optional().nullable(),
  storedIn: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/** On create the value is required; on edit, an empty box means "leave it alone". */
const createSchema = secretSchema.extend({
  value: z.string().min(1, "Enter the secret itself.").max(MAX_VALUE_LENGTH, "That is too long for one entry."),
});

const updateSchema = secretSchema.extend({
  value: z.string().max(MAX_VALUE_LENGTH, "That is too long for one entry.").optional().nullable(),
});

/**
 * What the stored value implies for the unencrypted columns. A .env file
 * keeps its variable names (searchable) and no hint: the last characters of a
 * file say nothing useful and could be the tail of a real value.
 */
function valueColumns(kind: string, value: string): { error: string } | { valueHint: string | null; envKeys: string[] | null } {
  if (kind !== "ENV_FILE") return { valueHint: valueHint(value), envKeys: null };
  const { variables } = parseEnvFile(value);
  if (variables.length === 0) return { error: "No variables found. Paste lines like NAME=value." };
  return { valueHint: null, envKeys: envKeys(value) };
}

/** Columns safe to select anywhere. The ciphertext is deliberately absent. */
const SAFE_COLUMNS = `
  id, secretNumber, name, kind, environment, status, service, username, url,
  valueHint, ownerUserId, projectId, envKeys, expiresAt, rotationDays, lastRotatedAt,
  storedIn, notes, createdById, createdAt, updatedAt
`;

/**
 * Record a read or a change against a secret.
 *
 * Failing to log is not allowed to fail the action it accompanies — refusing a
 * reveal because the log write failed would be a denial of service on the
 * vault — but it is surfaced in the server log rather than swallowed silently.
 */
async function logAccess(secretId: string, userId: string, action: string) {
  try {
    const db = await supabaseServer();
    await db.from("secret_access_log").insert({
      id: randomUUID(),
      secretId,
      userId,
      action,
    });
  } catch (err) {
    console.error(`Could not write secret access log for ${secretId}:`, err);
  }
}

/** True when the vault key is present, so screens can explain rather than break. */
export async function isVaultReady(): Promise<boolean> {
  await requirePermission(PERMISSIONS.SECRET_READ);
  return vaultKeyConfigured();
}

export async function listSecrets(filters?: {
  search?: string;
  environment?: string;
  status?: string;
  kind?: string;
  /** A project id, or "internal" for BabulTech Internal. */
  project?: string;
}) {
  await requirePermission(PERMISSIONS.SECRET_READ);

  const db = await supabaseServer();

  let query = db
    .from("secret")
    .select(`${SAFE_COLUMNS}, owner:app_user!secret_ownerUserId_fkey ( id, fullName ), project ( id, name, projectNumber )`)
    .is("deletedAt", null)
    .order("service")
    .order("name");

  if (filters?.environment) query = query.eq("environment", filters.environment);
  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.kind) query = query.eq("kind", filters.kind);
  if (filters?.project === "internal") query = query.is("projectId", null);
  else if (filters?.project) query = query.eq("projectId", filters.project);
  // Names and numbers by part; a .env file's variables by exact name, so
  // RESEND_API_KEY finds every project that uses it.
  const term = filters?.search?.replace(/[,(){}"]/g, "").trim();
  if (term) {
    const parts = ["name", "service", "username", "secretNumber"].map((c) => `${c}.ilike.%${term}%`);
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(term)) parts.push(`envKeys.cs.{${term}}`, `envKeys.cs.{${term.toUpperCase()}}`);
    query = query.or(parts.join(","));
  }

  const { data, error } = await query.limit(LIST_LIMIT);
  if (error) throw new Error(`Could not load the vault: ${error.message}`);

  return (data ?? []).map((row) => ({
    ...row,
    owner: Array.isArray(row.owner) ? row.owner[0] : row.owner,
    project: (Array.isArray(row.project) ? row.project[0] : row.project) as { id: string; name: string; projectNumber: string } | null,
  }));
}

export async function getSecret(id: string) {
  await requirePermission(PERMISSIONS.SECRET_READ);

  const db = await supabaseServer();

  const { data, error } = await db
    .from("secret")
    .select(
      `${SAFE_COLUMNS},
       owner:app_user!secret_ownerUserId_fkey ( id, fullName, email ),
       createdBy:app_user!secret_createdById_fkey ( id, fullName ),
       project ( id, name, projectNumber )`,
    )
    .eq("id", id)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) throw new Error(`Could not load the secret: ${error.message}`);
  if (!data) return null;

  // Who has looked at this, most recent first. The point of the vault during an
  // incident is answering exactly this.
  const { data: log } = await db
    .from("secret_access_log")
    .select("id, action, accessedAt, user:app_user!secret_access_log_userId_fkey ( id, fullName )")
    .eq("secretId", id)
    .order("accessedAt", { ascending: false })
    .limit(50);

  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

  return {
    ...data,
    owner: one(data.owner),
    createdBy: one(data.createdBy),
    project: one(data.project) as { id: string; name: string; projectNumber: string } | null,
    accessLog: (log ?? []).map((entry) => ({ ...entry, user: one(entry.user) })),
  };
}

/**
 * Decrypt one secret, and record who did it.
 *
 * The only path in the application that returns a plaintext credential.
 */
export async function revealSecret(id: string): Promise<ActionResult<{ value: string }>> {
  const _auth = await authorize(PERMISSIONS.SECRET_READ);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    const db = await supabaseServer();

    const { data, error } = await db
      .from("secret")
      .select("id, valueCiphertext, valueIv, valueTag")
      .eq("id", id)
      .is("deletedAt", null)
      .maybeSingle();

    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "That secret no longer exists." };

    const value = decryptSecret({
      ciphertext: data.valueCiphertext as string,
      iv: data.valueIv as string,
      tag: data.valueTag as string,
    });

    // Logged after a successful decrypt, so the log records reveals rather than
    // attempts. A failed decrypt is a configuration fault, not an access event.
    await logAccess(id, _auth.user.id, "REVEAL");
    revalidatePath(`/vault/${id}`);

    return { ok: true, data: { value } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not reveal this secret.",
    };
  }
}

export async function createSecret(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.SECRET_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { value: raw, ...d } = parsed.data;
  // A browser submits a textarea's line breaks as CRLF; a .env file is kept
  // with plain newlines, so Copy all gives back what was pasted.
  const value = d.kind === "ENV_FILE" && raw ? raw.replace(/\r\n?/g, "\n") : raw;
  const columns = valueColumns(d.kind, value);
  if ("error" in columns) return { ok: false, error: columns.error, fieldErrors: { value: [columns.error] } };

  try {
    const encrypted = encryptSecret(value);

    const created = await createRecord<{ id: string }>(
      "secret",
      {
        ...d,
        projectId: d.projectId || null,
        expiresAt: d.expiresAt || null,
        lastRotatedAt: d.lastRotatedAt || null,
        valueCiphertext: encrypted.ciphertext,
        valueIv: encrypted.iv,
        valueTag: encrypted.tag,
        ...columns,
        createdById: _auth.user.id,
        updatedAt: new Date().toISOString(),
      },
      { field: "secretNumber", sequence: "Secret" },
    );

    await logAccess(created.id, _auth.user.id, "CREATE");
    revalidatePath("/vault");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not save the secret.",
    };
  }
}

export async function updateSecret(
  id: string,
  input: z.input<typeof updateSchema>,
): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.SECRET_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { value: raw, ...d } = parsed.data;
  // A browser submits a textarea's line breaks as CRLF; a .env file is kept
  // with plain newlines, so Copy all gives back what was pasted.
  const value = d.kind === "ENV_FILE" && raw ? raw.replace(/\r\n?/g, "\n") : raw;

  try {
    const payload: Record<string, unknown> = {
      ...d,
      projectId: d.projectId || null,
      expiresAt: d.expiresAt || null,
      lastRotatedAt: d.lastRotatedAt || null,
      updatedAt: new Date().toISOString(),
    };

    // An empty value box means "I am editing the label, not the credential".
    // Treating blank as a new value would wipe a live key on any metadata edit.
    if (value) {
      const columns = valueColumns(d.kind, value);
      if ("error" in columns) return { ok: false, error: columns.error, fieldErrors: { value: [columns.error] } };
      const encrypted = encryptSecret(value);
      payload.valueCiphertext = encrypted.ciphertext;
      payload.valueIv = encrypted.iv;
      payload.valueTag = encrypted.tag;
      Object.assign(payload, columns);
      // Replacing the value IS the rotation, so the date follows it rather than
      // relying on someone remembering to set it by hand.
      payload.lastRotatedAt = new Date().toISOString().slice(0, 10);
    }

    await updateRecord("secret", id, payload, "Secret", _auth.user.id);

    await logAccess(id, _auth.user.id, value ? "ROTATE" : "UPDATE");
    revalidatePath("/vault");
    revalidatePath(`/vault/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not update the secret.",
    };
  }
}

/**
 * Retire a secret.
 *
 * Marked REVOKED and hidden rather than deleted: the access log has to keep
 * pointing at a row that still exists, or the record of who held a compromised
 * key disappears at exactly the moment it matters.
 */
export async function revokeSecret(id: string): Promise<ActionResult<{ id: string }>> {
  const _auth = await authorize(PERMISSIONS.SECRET_WRITE);
  if (!_auth.ok) return { ok: false, error: _auth.error };

  try {
    await updateRecord(
      "secret",
      id,
      {
        status: "REVOKED",
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "Secret",
      _auth.user.id,
    );

    await logAccess(id, _auth.user.id, "REVOKE");
    revalidatePath("/vault");
    return { ok: true, data: { id } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not revoke the secret.",
    };
  }
}

/** Projects that hold at least one secret, for the vault's project filter. */
export async function listVaultProjects() {
  await requirePermission(PERMISSIONS.SECRET_READ);
  const db = await supabaseServer();
  const { data } = await db.from("secret").select("project ( id, name )").is("deletedAt", null).not("projectId", "is", null);
  const seen = new Map<string, string>();
  for (const row of data ?? []) {
    const p = (Array.isArray(row.project) ? row.project[0] : row.project) as { id: string; name: string } | null;
    if (p) seen.set(p.id, p.name);
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** All secrets of one project, for the link on its page. Null without vault access. */
export async function countProjectSecrets(projectId: string): Promise<number | null> {
  const auth = await authorize(PERMISSIONS.SECRET_READ);
  if (!auth.ok) return null;
  const db = await supabaseServer();
  const { count } = await db.from("secret").select("id", { count: "exact", head: true }).eq("projectId", projectId).is("deletedAt", null);
  return count ?? 0;
}

/** The people a secret can be assigned to. */
export async function getVaultFormOptions() {
  await requirePermission(PERMISSIONS.SECRET_WRITE);

  const db = await supabaseServer();
  const { data } = await db
    .from("app_user")
    .select("id, fullName, jobTitle")
    .eq("status", "ACTIVE")
    .is("deletedAt", null)
    .order("fullName");

  return { users: data ?? [] };
}
