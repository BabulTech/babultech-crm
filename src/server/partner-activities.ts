"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Resend } from "@/lib/mail";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import { requireUser, can, PERMISSIONS } from "@/lib/authz";
import { getPortalContext } from "./portal";
import type { ActionResult } from "./partners";

/**
 * The conversation with a partner: messages, email and files, in one thread.
 *
 * The same functions serve both ends. Which side the author is on is decided in
 * the database from the session, never passed in, so a partner cannot post a
 * message that appears to come from us. Everything a partner may do here they
 * may do only against their own partnership.
 */

const BUCKET = "partner-attachments";
const MAX_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_SECONDS = 300;

/**
 * What may be attached. An allow-list, matching the one used for note
 * attachments — SVG and HTML are deliberately absent because either can carry
 * script when served from our own origin.
 */
const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "application/zip",
]);

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);


export interface PartnerAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  isImage: boolean;
  /** Short-lived signed URL; null when the object could not be signed. */
  url: string | null;
}

export interface PartnerMessage {
  id: string;
  partnerId: string;
  kind: "MESSAGE" | "EMAIL";
  authorSide: "PARTNER" | "INTERNAL";
  authorName: string;
  subject: string | null;
  toAddresses: string[] | null;
  body: string;
  readAt: string | null;
  createdAt: string;
  attachments: PartnerAttachment[];
}

/**
 * Resolve which partnership the caller is acting on.
 *
 * A partner is pinned to their own; a colleague must say which, and must hold
 * partner:read to say it at all.
 */
async function resolvePartnerId(requested?: string): Promise<string> {
  const ctx = await getPortalContext();
  if (ctx?.partnerId) return ctx.partnerId;

  const me = await requireUser();
  if (!can(me, PERMISSIONS.PARTNER_READ)) {
    throw new Error("You do not have access to partner conversations.");
  }
  if (!requested) throw new Error("Which partner?");
  return requested;
}

/** The whole thread, oldest first, with signed links for any attachments. */
export async function getPartnerThread(partnerId?: string): Promise<PartnerMessage[]> {
  const id = await resolvePartnerId(partnerId);
  const db = await supabaseServer();

  const { data, error } = await db
    .from("partner_message")
    .select(
      `id, partnerId, kind, authorSide, authorName, subject, toAddresses, body,
       readAt, createdAt,
       attachments:partner_message_attachment (
         id, fileName, mimeType, fileSizeBytes, isImage, storagePath
       )`,
    )
    .eq("partnerId", id)
    .is("deletedAt", null)
    .order("createdAt", { ascending: true })
    .limit(500);

  if (error) throw new Error(`Could not load the conversation: ${error.message}`);

  // Signed in one batch. The bucket is private, so nothing has a usable
  // address until it is signed, and a signature is short-lived on purpose.
  const paths = (data ?? []).flatMap((m) =>
    (m.attachments ?? []).map((a: { storagePath: string }) => a.storagePath),
  );

  const signed = new Map<string, string>();
  if (paths.length) {
    const { data: urls } = await supabaseAdmin()
      .storage.from(BUCKET)
      .createSignedUrls(paths, SIGNED_URL_SECONDS);
    for (const u of urls ?? []) {
      if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
    }
  }

  return (data ?? []).map((m) => ({
    ...m,
    attachments: (m.attachments ?? []).map((a: Omit<PartnerAttachment, "url"> & { storagePath: string }) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSizeBytes: a.fileSizeBytes,
      isImage: a.isImage,
      url: signed.get(a.storagePath) ?? null,
    })),
  })) as PartnerMessage[];
}

/** How many messages from the other side are unread. Drives the badge. */
export async function countUnreadPartnerMessages(partnerId?: string): Promise<number> {
  let id: string;
  try {
    id = await resolvePartnerId(partnerId);
  } catch {
    return 0;
  }

  const ctx = await getPortalContext();
  const theirSide = ctx?.partnerId ? "INTERNAL" : "PARTNER";

  const db = await supabaseServer();
  const { count } = await db
    .from("partner_message")
    .select("id", { count: "exact", head: true })
    .eq("partnerId", id)
    .eq("authorSide", theirSide)
    .is("readAt", null)
    .is("deletedAt", null);

  return count ?? 0;
}

export async function markPartnerThreadRead(partnerId?: string): Promise<ActionResult<{ marked: number }>> {
  let id: string;
  try {
    id = await resolvePartnerId(partnerId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("mark_partner_messages_read", { p_partner_id: id });
  if (error) return { ok: false, error: error.message };

  return { ok: true, data: { marked: Number(data ?? 0) } };
}

// ---------------------------------------------------------------------------
// Saying something
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  partnerId: z.string().uuid().optional(),
  body: z.string().trim().min(1, "There is nothing to send.").max(10000),
});

export async function postPartnerMessage(
  input: z.infer<typeof messageSchema>,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    id = await resolvePartnerId(input.partnerId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the message." };
  }

  const db = await supabaseServer();
  const { data, error } = await db.rpc("post_partner_message", {
    p_partner_id: id,
    p_body: parsed.data.body,
    p_kind: "MESSAGE",
    p_subject: null,
    p_to: null,
    p_email_id: null,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/portal/activities");
  revalidatePath(`/partners/${id}`);
  return { ok: true, data: data as { id: string } };
}

const emailSchema = z.object({
  partnerId: z.string().uuid().optional(),
  to: z.string().trim().email("That does not look like an email address."),
  subject: z.string().trim().min(1, "Give the email a subject.").max(300),
  body: z.string().trim().min(1, "There is nothing to send.").max(10000),
});

/**
 * Send an email, and keep it in the thread.
 *
 * The message is written first and the send attempted second. If the send
 * fails, what the person wrote still exists and can be seen and retried —
 * losing somebody's typing because a mail provider was briefly unavailable is
 * the worse failure.
 *
 * It sends from our own address with the author's as reply-to, rather than
 * from the author: sending as a partner's own domain would fail authentication
 * and land in spam, and sending as them from ours would be a small forgery.
 */
export async function sendPartnerEmail(
  input: z.infer<typeof emailSchema>,
): Promise<ActionResult<{ id: string; sent: boolean; error: string | null }>> {
  let id: string;
  try {
    id = await resolvePartnerId(input.partnerId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not signed in." };
  }

  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  const db = await supabaseServer();
  const admin = supabaseAdmin();
  const from = process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>";

  // Who is writing, for the reply-to and the email record.
  // Reply-to is the author's own address, so an answer reaches the person who
  // wrote rather than a shared inbox. requireUser() serves both sides: a
  // partner login is an app_user like any other.
  const author = await requireUser();
  const replyTo = author.email ?? undefined;

  const emailId = randomUUID();
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${escapeHtml(d.body)}</div>`;

  await admin.from("email").insert({
    id: emailId,
    direction: "OUTBOUND",
    subject: d.subject,
    fromAddress: from,
    toAddresses: [d.to],
    bodyHtml: html,
    bodyText: d.body,
    relatedEntityType: "Partner",
    relatedEntityId: id,
    sentReceivedAt: new Date().toISOString(),
    status: "QUEUED",
    updatedAt: new Date().toISOString(),
  });

  const { data: posted, error } = await db.rpc("post_partner_message", {
    p_partner_id: id,
    p_body: d.body,
    p_kind: "EMAIL",
    p_subject: d.subject,
    p_to: [d.to],
    p_email_id: emailId,
  });

  if (error) return { ok: false, error: error.message };

  let sent = false;
  let failure: string | null = null;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    failure = "No mail provider is configured.";
  } else {
    const result = await new Resend(key, "Partner activity").emails.send({
      from,
      to: d.to,
      replyTo,
      subject: d.subject,
      html,
      text: d.body,
    });
    if (result.error) failure = result.error.message;
    else sent = true;
  }

  await admin
    .from("email")
    .update({
      status: sent ? "SENT" : "FAILED",
      updatedAt: new Date().toISOString(),
    })
    .eq("id", emailId);

  revalidatePath("/portal/activities");
  revalidatePath(`/partners/${id}`);
  return {
    ok: true,
    data: { id: (posted as { id: string }).id, sent, error: failure },
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function attachToPartnerMessage(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const messageId = String(formData.get("messageId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
    return { ok: false, error: "That message no longer exists." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file to attach." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.`,
    };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return {
      ok: false,
      error: `${file.type || "That file type"} cannot be attached. Images, PDFs, Office files and text are accepted.`,
    };
  }

  // Named by a uuid, never by the uploaded filename: a caller-supplied name is
  // a path-traversal and collision risk. The display name lives in the row.
  const extension = file.name.includes(".") ? file.name.split(".").pop()!.slice(0, 10) : "bin";
  const storagePath = `${messageId}/${randomUUID()}.${extension}`;

  const storage = supabaseAdmin();
  const { error: uploadError } = await storage.storage
    .from(BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}` };

  // The row goes through the caller's own client, so the function's ownership
  // check applies. A file nothing points at is removed rather than orphaned.
  const db = await supabaseServer();
  const { data, error } = await db.rpc("attach_to_partner_message", {
    p_message_id: messageId,
    p_file_name: file.name,
    p_mime_type: file.type,
    p_size_bytes: file.size,
    p_path: storagePath,
    p_is_image: IMAGE_MIME.has(file.type),
  });

  if (error) {
    await storage.storage.from(BUCKET).remove([storagePath]);
    return { ok: false, error: error.message };
  }

  revalidatePath("/portal/activities");
  return { ok: true, data: data as { id: string } };
}
