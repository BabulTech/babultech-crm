/**
 * The kinds of notification, as the settings screen lists them.
 *
 * The database decides when each is sent (supabase/migrations/
 * 20260929000001_notifications_and_follows.sql); this is what they are called
 * and whether they go by email when nobody has said. Keep `emailByDefault` in
 * step with notification_email_by_default() there.
 */
export const NOTIFICATION_KINDS = [
  { kind: "ASSIGNED", label: "Assigned to me", description: "A lead, account, deal, case, project or task is given to you.", emailByDefault: true },
  { kind: "APPROVAL_REQUESTED", label: "Approval needed", description: "A quote, expense or other request is waiting for your approval.", emailByDefault: true },
  { kind: "APPROVAL_DECIDED", label: "Approval decided", description: "Something you asked to have approved was approved or rejected.", emailByDefault: true },
  { kind: "MENTION", label: "Mentioned in a note", description: "Someone @mentions you. The email for this is sent by the note itself.", emailByDefault: false, emailFixed: true },
  { kind: "CASE_CUSTOMER_REPLY", label: "Customer replied", description: "A customer writes on a case you own or follow.", emailByDefault: false },
  { kind: "PARTNER_LEAD", label: "Partner registered a lead", description: "A partner you manage adds a lead in the portal.", emailByDefault: false },
  { kind: "QUOTE_ACCEPTED", label: "Quote accepted", description: "A quote on your deal, or a deal you follow, is accepted.", emailByDefault: false },
  { kind: "HOT_LEAD", label: "Hot lead", description: "A lead you own first reaches the lead-scoring threshold.", emailByDefault: false },
  { kind: "DEAL_WON", label: "Deal won", description: "A deal you own or follow is closed won.", emailByDefault: false },
  { kind: "TIMESHEET_REMINDER", label: "Log today's time", description: "At 9 pm, when you have logged nothing that day.", emailByDefault: false },
  { kind: "TIMESHEET_DUE", label: "Submit your timesheet", description: "Sunday at 9 pm if the week is not submitted, and Monday morning if it is still not in.", emailByDefault: true },
  { kind: "TASK_DUE", label: "Due tomorrow and overdue", description: "Checked every morning for your tasks, calls, meetings and project tasks.", emailByDefault: false },
  { kind: "FOLLOWED_CHANGE", label: "Records I follow", description: "The stage, status or owner changes, or a note is added.", emailByDefault: false },
  { kind: "AUTOMATION", label: "Reminders from rules", description: "An automatic rule spotted something: a lead with no follow-up, a deal not moving, a case response due soon.", emailByDefault: false },
  { kind: "REPORT_READY", label: "Scheduled reports", description: "A report you asked for weekly or monthly is ready.", emailByDefault: true },
  { kind: "JOB_FINISHED", label: "Background work finished", description: "A mass email or import you started has finished.", emailByDefault: false },
  { kind: "RECORD_CORRECTED", label: "Records corrected", description: "An administrator corrects a record of yours that was already approved, issued, paid or closed, and says why.", emailByDefault: false },
  { kind: "CONTRACT_SIGNED", label: "Contract signed by a hire", description: "A new hire signs their contract through the link, and it needs signing for the company.", emailByDefault: false },
  { kind: "CONTRACT_ENDING", label: "Contracts ending", description: "A contract you manage, or of someone reporting to you, ends in 30, 14 or 7 days.", emailByDefault: false },
  { kind: "CONTRACT_ENDED", label: "Contracts over", description: "Someone's last contract is over and their login was switched off.", emailByDefault: false },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["kind"];

export const FOLLOWABLE_TYPES = ["Lead", "Account", "Contact", "Opportunity", "SupportCase", "Project"] as const;
export type FollowableType = (typeof FOLLOWABLE_TYPES)[number];
