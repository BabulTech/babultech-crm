import { sendNextLeadEmails } from "./lead-mailer";
import { sendPendingNotificationEmails } from "./notification-mailer";
import { deliverWebhooks } from "./webhook-delivery";
import { sendWeeklySummary } from "./weekly-summary";

/**
 * What each kind of background job does, one chunk at a time.
 *
 * A handler does a bounded piece of work and says whether the job is finished.
 * The runner (lib/jobs.ts) keeps calling it until it is, saving progress
 * between calls, so no handler ever needs to finish inside one request.
 */

export interface JobRow {
  id: string;
  jobType: string;
  status: string;
  title: string;
  payload: Record<string, unknown>;
  cursor: Record<string, unknown>;
  progressDone: number;
  progressTotal: number | null;
  errors: string[];
  attempts: number;
  createdById: string | null;
}

export interface JobStep {
  processed: number;
  done: boolean;
  cursor?: Record<string, unknown>;
  progressTotal?: number | null;
  result?: Record<string, unknown> | null;
  errors?: string[];
}

export type JobHandler = (job: JobRow) => Promise<JobStep>;

/** Mass email to leads: sends the next hundred of the batch's messages. */
const leadEmail: JobHandler = async (job) => {
  const batchId = String(job.payload.batchId ?? "");
  const step = await sendNextLeadEmails(batchId);
  const sent = Number(job.cursor.sent ?? 0) + step.sent;
  const failed = Number(job.cursor.failed ?? 0) + step.failed;
  return {
    processed: step.processed,
    done: step.remaining === 0,
    cursor: { sent, failed },
    result: { batchId, sent, failed },
    errors: step.failed ? [`${step.failed} message${step.failed === 1 ? "" : "s"} could not be sent.`] : [],
  };
};

/** The Monday summary to the Super Admin and CRM Admins, in one go. */
const weeklySummary: JobHandler = async () => {
  const r = await sendWeeklySummary();
  return { processed: r.sent + r.failed, done: true, result: { sent: r.sent, failed: r.failed }, errors: r.errors };
};

export const JOB_HANDLERS = {
  lead_email: leadEmail,
  weekly_summary: weeklySummary,
} satisfies Record<string, JobHandler>;

export type JobType = keyof typeof JOB_HANDLERS;

/**
 * Work the runner also does on every visit, outside the job queue: small,
 * recurring and owned by nobody in particular. Each returns how many items it
 * handled.
 */
export const RUNNER_CHORES: ((deadline: number) => Promise<number>)[] = [
  sendPendingNotificationEmails,
  deliverWebhooks,
];
