/**
 * The rules of prospect outreach, from ORMS. Shared by the screens and the
 * server: statuses within a campaign, what Quick log records, which channels
 * allow which actions, the status each action suggests, and the follow-up
 * task each one creates.
 */

export const CAMPAIGN_STATUSES = ["new", "contacted", "following_up", "replied", "interested_meeting", "won", "lost", "no_fit"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  new: "New",
  contacted: "Contacted",
  following_up: "Following up",
  replied: "Replied",
  interested_meeting: "Interested / meeting",
  won: "Won",
  lost: "Lost",
  no_fit: "No fit / no response",
};

export const CAMPAIGN_STATUS_TONE: Record<CampaignStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  new: "neutral", contacted: "info", following_up: "info", replied: "warning", interested_meeting: "success", won: "success", lost: "danger", no_fit: "neutral",
};

export const QUICK_LOG_ACTIONS = ["EMAIL_SENT", "FOLLOWUP_SENT", "EMAIL_REPLY", "CALL_ATTEMPTED", "CALL_CONNECTED", "VOICEMAIL", "MEETING_BOOKED"] as const;
export type QuickLogAction = (typeof QUICK_LOG_ACTIONS)[number];

export const ACTIVITY_LABELS: Record<string, string> = {
  EMAIL_SENT: "Email sent",
  FOLLOWUP_SENT: "Follow-up sent",
  EMAIL_REPLY: "Reply received",
  CALL_ATTEMPTED: "Call, no answer",
  CALL_CONNECTED: "Call connected",
  VOICEMAIL: "Voicemail left",
  MEETING_BOOKED: "Meeting booked",
  MEETING_COMPLETED: "Meeting held",
  NOTE_ADDED: "Note",
  STATUS_CHANGED: "Status changed",
  INFO_UPDATED: "Details updated",
};

/** What counts as a touch for the campaign's touch count. */
export const TOUCH_TYPES: string[] = ["EMAIL_SENT", "FOLLOWUP_SENT", "CALL_ATTEMPTED", "CALL_CONNECTED", "VOICEMAIL"];

export const CHANNELS = ["business_phone", "business_email", "personal_phone", "personal_email", "whatsapp", "linkedin", "contact_form", "in_person", "other"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  business_phone: "Business phone",
  business_email: "Business email",
  personal_phone: "Personal phone",
  personal_email: "Personal email",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  contact_form: "Contact form",
  in_person: "In person",
  other: "Other",
};

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/** Phones cannot send emails; written channels cannot take calls. */
export function channelAllows(channel: Channel | null, action: string): boolean {
  if (!channel) return true;
  const phoneOnly = channel === "business_phone" || channel === "personal_phone";
  const writtenOnly = ["business_email", "personal_email", "contact_form", "linkedin"].includes(channel);
  if (["CALL_ATTEMPTED", "CALL_CONNECTED", "VOICEMAIL"].includes(action)) return !writtenOnly;
  if (["EMAIL_SENT", "FOLLOWUP_SENT", "EMAIL_REPLY"].includes(action)) return !phoneOnly;
  return true;
}

/** The status an action suggests, from the statuses it can move on from. Never applied silently. */
export const STATUS_SUGGESTION: Partial<Record<QuickLogAction, { from: CampaignStatus[]; to: CampaignStatus }>> = {
  EMAIL_SENT: { from: ["new"], to: "contacted" },
  CALL_ATTEMPTED: { from: ["new"], to: "contacted" },
  CALL_CONNECTED: { from: ["new", "contacted"], to: "following_up" },
  VOICEMAIL: { from: ["new"], to: "contacted" },
  FOLLOWUP_SENT: { from: ["new", "contacted"], to: "following_up" },
  EMAIL_REPLY: { from: ["new", "contacted", "following_up"], to: "replied" },
  MEETING_BOOKED: { from: ["new", "contacted", "following_up", "replied"], to: "interested_meeting" },
};

export const TASK_TYPE_LABELS: Record<string, string> = {
  followup_email: "Follow-up email",
  call_lead: "Call",
  meeting_reminder: "Meeting",
  general_reminder: "Reminder",
};

/** Adds working days (Monday to Friday) to a date, as yyyy-mm-dd. */
export function addBusinessDays(from: Date, days: number): string {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** The follow-up task an action creates, if any. A reply leaves the next step to the person. */
export function followUpFor(action: QuickLogAction, followupDays: number, now = new Date()) {
  switch (action) {
    case "EMAIL_SENT":
    case "FOLLOWUP_SENT":
      return { type: "followup_email", title: "Follow up on email", dueDate: addBusinessDays(now, followupDays) };
    case "CALL_ATTEMPTED":
    case "VOICEMAIL":
      return { type: "call_lead", title: "Try calling again", dueDate: addBusinessDays(now, 1) };
    case "MEETING_BOOKED":
      return { type: "meeting_reminder", title: "Prepare for the meeting", dueDate: addBusinessDays(now, 1) };
    default:
      return null;
  }
}
