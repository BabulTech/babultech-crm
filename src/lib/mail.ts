import { Resend as Provider } from "resend";
import { supabaseAdmin } from "./supabase";
import { requireUser } from "./authz";

/**
 * The one way out for email. It sends exactly as the provider's client does,
 * and records every attempt, delivered or not, in the activity log. Import
 * Resend from here, never from "resend", and name the source: an email that
 * skips this class is an email the audit trail cannot see.
 *
 * Message bodies are deliberately not stored: who, what subject and the outcome
 * are the trail, and the content can hold customer detail.
 */

export interface MailContext {
  entityType?: string | null;
  entityId?: string | null;
  /** Who the action belongs to, where the sender is not the signed-in person. */
  actorId?: string | null;
}

type SendPayload = Parameters<Provider["emails"]["send"]>[0];
type BatchPayload = Parameters<Provider["batch"]["send"]>[0];

const list = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String);

async function currentActor(): Promise<{ id: string; fullName: string } | null> {
  // No session in a background run, and requireUser redirects rather than returns.
  try {
    const me = await requireUser();
    return { id: me.id, fullName: me.fullName };
  } catch {
    return null;
  }
}

async function record(source: string, payload: SendPayload, context: MailContext | undefined, error: string | null, providerId: string | null) {
  try {
    const to = list(payload.to);
    const actor = context?.actorId ? null : await currentActor();
    await supabaseAdmin().from("activity_event").insert({
      category: "EMAIL",
      action: source.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40),
      outcome: error ? "FAILED" : "OK",
      summary: `Email to ${to.join(", ")}: ${payload.subject}`.slice(0, 500),
      actorId: context?.actorId ?? actor?.id ?? null,
      actorName: actor?.fullName ?? (context?.actorId ? null : "BabulTech CRM"),
      entityType: context?.entityType ?? null,
      entityId: context?.entityId ?? null,
      detail: { source, to, cc: list(payload.cc), bcc: list(payload.bcc), from: payload.from, subject: payload.subject, error, providerId },
    });
  } catch (err) {
    // A log failure must not turn a delivered email into a failed action.
    console.error("Could not log an email", err);
  }
}

export class Resend {
  private provider: Provider;
  private source: string;

  constructor(key: string | undefined, source: string) {
    this.provider = new Provider(key);
    this.source = source;
  }

  emails = {
    send: async (payload: SendPayload, context?: MailContext) => {
      try {
        const result = await this.provider.emails.send(payload);
        await record(this.source, payload, context, result.error?.message ?? null, result.data?.id ?? null);
        return result;
      } catch (err) {
        await record(this.source, payload, context, err instanceof Error ? err.message : String(err), null);
        throw err;
      }
    },
  };

  batch = {
    send: async (payloads: BatchPayload, context?: MailContext) => {
      try {
        const result = await this.provider.batch.send(payloads);
        for (const payload of payloads) await record(this.source, payload as SendPayload, context, result.error?.message ?? null, null);
        return result;
      } catch (err) {
        for (const payload of payloads) await record(this.source, payload as SendPayload, context, err instanceof Error ? err.message : String(err), null);
        throw err;
      }
    },
  };
}
