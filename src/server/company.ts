"use server";

import { revalidatePath } from "next/cache";
import { describeInvalid } from "@/lib/form-errors";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase";
import { PERMISSIONS, authorize, requirePermission } from "@/lib/authz";
import { invalidateCurrencyContext } from "@/lib/currency-loader";
import type { ActionResult } from "./partners";

/**
 * The organisation itself: its settings, the currencies it deals in, its
 * working week, and how big it has grown.
 *
 * Administrators only throughout. The totals are the WHOLE organisation's,
 * counted past every visibility rule, and a rate or a default currency changes
 * how every amount on every screen is shown.
 */

export interface CompanySetting {
  companyName: string;
  locale: string;
  timezone: string;
  language: string;
  defaultCurrency: string;
  corporateCurrency: string;
  accountId: string | null;
  updatedAt: string;
}

export interface CompanyOverview {
  users: number;
  customers: number;
  deals: number;
  partners: number;
  cases: number;
  leads: number;
  databaseBytes: number;
  fileBytes: number;
}

export interface CurrencyRow {
  code: string;
  name: string;
  symbol: string | null;
  exchangeRate: string;
  isBase: boolean;
  active: boolean;
  updatedAt: string;
}

export interface BusinessHoursRow {
  id: string;
  name: string;
  timezone: string;
  weeklySchedule: Record<string, { start: string; end: string } | null>;
  /** Days the office is closed; SLA clocks skip them. */
  holidayCalendar: { date: string; name: string }[] | null;
  isDefault: boolean;
  active: boolean;
}

export async function getCompanyInformation(): Promise<{
  setting: CompanySetting | null;
  overview: CompanyOverview | null;
  currencies: CurrencyRow[];
  businessHours: BusinessHoursRow[];
  accountName: string | null;
}> {
  await requirePermission(PERMISSIONS.ADMIN);
  const db = await supabaseServer();

  const [setting, overview, currencies, hours] = await Promise.all([
    db.from("company_setting").select("*").maybeSingle(),
    db.rpc("company_overview"),
    db.from("currency").select("code, name, symbol, exchangeRate, isBase, active, updatedAt").order("isBase", { ascending: false }).order("code"),
    db.from("business_hours").select("id, name, timezone, weeklySchedule, holidayCalendar, isDefault, active").order("isDefault", { ascending: false }).order("name"),
  ]);

  let accountName: string | null = null;
  if (setting.data?.accountId) {
    const { data } = await db.from("account").select("name").eq("id", setting.data.accountId).maybeSingle();
    accountName = (data?.name as string) ?? null;
  }

  return {
    setting: (setting.data as CompanySetting) ?? null,
    overview: (overview.data as CompanyOverview) ?? null,
    currencies: (currencies.data ?? []).map((c) => ({
      ...c,
      code: String(c.code).trim(),
      exchangeRate: String(c.exchangeRate),
    })) as CurrencyRow[],
    businessHours: (hours.data ?? []) as BusinessHoursRow[],
    accountName,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_CURRENCIES = ["PKR", "USD", "CAD", "AUD", "AED"] as const;

const settingSchema = z.object({
  companyName: z.string().trim().min(1, "The company needs a name.").max(200),
  locale: z.string().trim().min(2).max(20),
  timezone: z.string().trim().min(1).max(64),
  language: z.string().trim().min(2).max(20),
  defaultCurrency: z.enum(DEFAULT_CURRENCIES, { message: "Choose PKR, USD, CAD, AUD or AED." }),
  corporateCurrency: z.string().trim().length(3, "Choose a currency."),
});

export async function saveCompanySetting(
  input: z.infer<typeof settingSchema>,
): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = settingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const db = await supabaseServer();
  const { error } = await db
    .from("company_setting")
    .update({ ...parsed.data, updatedAt: new Date().toISOString(), updatedById: auth.user.id })
    .eq("id", true);

  if (error) return { ok: false, error: error.message };

  // Which currency is shown beside which has just changed.
  invalidateCurrencyContext();
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

const currencySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "A currency code is three letters, such as USD."),
  name: z.string().trim().min(1, "Give the currency a name.").max(100),
  symbol: z.string().trim().max(10).optional().nullable(),
  exchangeRate: z.coerce
    .number({ message: "Enter a rate." })
    .positive("A rate must be more than zero."),
  active: z.coerce.boolean().default(true),
});

/**
 * Add a currency, or change one's rate.
 *
 * The rate is how many PKR one unit buys. The base currency's rate is 1 by
 * definition - every conversion goes through it - so it cannot be edited here,
 * and the database refuses it too.
 */
export async function saveCurrency(
  input: z.infer<typeof currencySchema>,
): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = currencySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;
  const db = await supabaseServer();

  const { data: existing } = await db.from("currency").select("isBase").eq("code", d.code).maybeSingle();
  if (existing?.isBase && d.exchangeRate !== 1) {
    return {
      ok: false,
      error: `${d.code} is the base currency: every rate is measured against it, so its own rate is always 1.`,
      fieldErrors: { exchangeRate: ["The base currency's rate is always 1."] },
    };
  }
  if (existing?.isBase && !d.active) {
    return { ok: false, error: "The base currency cannot be switched off - every conversion goes through it." };
  }

  const now = new Date().toISOString();
  const { error } = existing
    ? await db
        .from("currency")
        .update({ name: d.name, symbol: d.symbol || null, exchangeRate: d.exchangeRate, active: d.active, updatedAt: now })
        .eq("code", d.code)
    : await db
        .from("currency")
        .insert({ code: d.code, name: d.name, symbol: d.symbol || null, exchangeRate: d.exchangeRate, active: d.active, isBase: false, updatedAt: now });

  if (error) return { ok: false, error: error.message };

  invalidateCurrencyContext();
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 09:00.");

const hoursSchema = z
  .object({
    id: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1, "Give the schedule a name.").max(100),
    timezone: z.string().trim().min(1, "Choose a time zone.").max(100),
    isDefault: z.coerce.boolean().default(false),
    days: z.record(
      z.enum(DAYS),
      z.object({ open: z.boolean(), start: z.string(), end: z.string() }),
    ),
  })
  .superRefine((v, ctx) => {
    for (const day of DAYS) {
      const d = v.days[day];
      if (!d?.open) continue;
      const s = time.safeParse(d.start);
      const e = time.safeParse(d.end);
      if (!s.success || !e.success) {
        ctx.addIssue({ code: "custom", path: [day], message: `${day[0].toUpperCase()}${day.slice(1)}: use 24-hour times such as 09:00.` });
      } else if (d.end <= d.start) {
        ctx.addIssue({ code: "custom", path: [day], message: `${day[0].toUpperCase()}${day.slice(1)}: closing has to be after opening.` });
      }
    }
  });

/**
 * Save a working week.
 *
 * SLA timers count only the hours in here, so a day marked closed is a day a
 * support clock does not run - which is why each day is either a real range or
 * explicitly closed, never half-filled.
 */
export async function saveBusinessHours(
  input: z.infer<typeof hoursSchema>,
): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = hoursSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: describeInvalid(parsed.error),
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const d = parsed.data;

  // Stored in the shape the SLA engine already reads: a day is { start, end }
  // or null for closed.
  const weeklySchedule: Record<string, { start: string; end: string } | null> = {};
  for (const day of DAYS) {
    const v = d.days[day];
    weeklySchedule[day] = v?.open ? { start: v.start, end: v.end } : null;
  }

  const db = await supabaseServer();
  const now = new Date().toISOString();

  // One default at a time: SLA policies fall back to it, and two would make
  // the fallback a coin toss.
  if (d.isDefault) {
    let clear = db.from("business_hours").update({ isDefault: false, updatedAt: now }).eq("isDefault", true);
    if (d.id) clear = clear.neq("id", d.id);
    const { error } = await clear;
    if (error) return { ok: false, error: error.message };
  }

  const row = { name: d.name, timezone: d.timezone, weeklySchedule, isDefault: d.isDefault, active: true, updatedAt: now };
  const { data, error } = d.id
    ? await db.from("business_hours").update(row).eq("id", d.id).select("id").maybeSingle()
    : await db.from("business_hours").insert({ id: crypto.randomUUID(), ...row }).select("id").single();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That schedule no longer exists." };

  revalidatePath("/company");
  return { ok: true, data: { id: data.id as string } };
}

const holidaysSchema = z.object({
  businessHoursId: z.string().uuid(),
  holidays: z
    .array(z.object({ date: z.string().regex(/^d{4}-d{2}-d{2}$/, "Each holiday needs a date."), name: z.string().trim().min(1, "Give each holiday a name.").max(120) }))
    .max(200),
});

/**
 * The days the office is closed. SLA clocks skip them, as they skip evenings
 * and days off; a deadline that would land on one moves to the next working
 * time. Deadlines already set are not moved.
 */
export async function saveHolidays(input: z.infer<typeof holidaysSchema>): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = holidaysSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the holidays." };
  const holidays = [...new Map(parsed.data.holidays.map((h) => [h.date, h])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const db = await supabaseServer();
  const { error } = await db
    .from("business_hours")
    .update({ holidayCalendar: holidays, updatedAt: new Date().toISOString() })
    .eq("id", parsed.data.businessHoursId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/company/business-hours");
  return { ok: true, data: undefined };
}
