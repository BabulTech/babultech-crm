import { z } from "zod";

/**
 * Validation messages that say which field is wrong.
 *
 * Saves used to answer "Please correct the highlighted fields." - often on a
 * form that highlights nothing - or a bare "Required", so nobody could tell
 * what to fix. Every default message now names its field, and describeInvalid
 * lists every field at once: "Please fill in: Name, Service."
 *
 * Messages written into a schema by hand are kept as they are.
 */

/** "projectManagerId" → "Project manager", "ownerUserId" → "Owner". */
export function fieldLabel(path: readonly (string | number)[]): string {
  const key = [...path].reverse().find((p): p is string => typeof p === "string");
  if (!key) return "This field";
  const trimmed = key.replace(/(User)?Id$/, "") || key;
  const words = trimmed.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const REQUIRED = " is required.";

function isMissing(issue: z.ZodIssueOptionalMessage): boolean {
  if (issue.code === "invalid_type") return issue.received === "undefined" || issue.received === "null";
  if (issue.code === "too_small") return issue.type === "string" && Number(issue.minimum) === 1;
  return false;
}

const messages: z.ZodErrorMap = (issue, ctx) => {
  if (!issue.path.length) return { message: ctx.defaultError };
  const label = fieldLabel(issue.path);
  // An empty box or an unchosen dropdown arrives as "" - that is missing too.
  if (isMissing(issue) || ctx.data === "") return { message: `${label}${REQUIRED}` };
  switch (issue.code) {
    case "invalid_string":
      if (issue.validation === "email") return { message: `${label}: enter a valid email address.` };
      if (issue.validation === "url") return { message: `${label}: enter a full web address, starting with https://.` };
      if (issue.validation === "uuid") return { message: `${label}: choose one from the list.` };
      break;
    case "invalid_type":
      if (issue.expected === "number") return { message: `${label} must be a number.` };
      if (issue.expected === "date") return { message: `${label} must be a date.` };
      break;
    case "invalid_enum_value":
      return { message: `${label}: choose one of the options.` };
    case "too_small":
      if (issue.type === "string") return { message: `${label} must be at least ${issue.minimum} characters.` };
      if (issue.type === "number") return { message: `${label} must be ${issue.inclusive ? "at least" : "more than"} ${issue.minimum}.` };
      if (issue.type === "array") return { message: `${label}: choose at least ${issue.minimum}.` };
      break;
    case "too_big":
      if (issue.type === "string") return { message: `${label} must be ${issue.maximum} characters or fewer.` };
      if (issue.type === "number") return { message: `${label} must be ${issue.inclusive ? "at most" : "less than"} ${issue.maximum}.` };
      break;
  }
  return { message: `${label}: ${ctx.defaultError}` };
};

z.setErrorMap(messages);

/**
 * One sentence for a failed save: the missing fields together, then anything
 * else that is wrong. "Please fill in: Name, Service. Email: enter a valid
 * email address."
 */
export function describeInvalid(error: z.ZodError): string {
  const missing: string[] = [];
  const other: string[] = [];
  for (const issue of error.issues) {
    if (issue.path.length && (isMissing(issue) || issue.message.endsWith(REQUIRED))) {
      const label = fieldLabel(issue.path);
      if (!missing.includes(label)) missing.push(label);
    } else if (!other.includes(issue.message)) {
      other.push(issue.message);
    }
  }
  const parts = [];
  if (missing.length) parts.push(`Please fill in: ${missing.join(", ")}.`);
  parts.push(...other.map((m) => (/[.!?]$/.test(m) ? m : `${m}.`)));
  return parts.join(" ") || "Some details are not valid.";
}
