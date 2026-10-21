"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";
import { authorize, authorizeAny, requireUser, can, canAny, PERMISSIONS, type SessionUser } from "@/lib/authz";
import { one } from "@/lib/decimal";
import { SEQUENCES } from "@/lib/numbering";
import {
  CONTRACT_TYPES, PAY_BASES, CANCELLABLE_STATUSES, CONTRACT_TYPE_LABELS, SIGNING_LINK_DAYS,
  termEndDate, dayAfter, karachiToday, tenureLabel, payLabel, fillContract, benefitLines, contractDate, hourlyCost, daysUntil,
  percentLabel, vestingLabel, capitalLabel,
  type ContractType, type EducationEntry, type ExperienceEntry,
} from "@/lib/people";
import { renderDocumentEmail, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID } from "@/lib/email-template";
import { renderSystemEmail } from "@/lib/system-emails";
import { createUser } from "./users";
import type { ActionResult } from "./partners";

/**
 * People: hiring profiles and employment contracts.
 *
 * The tables are service-role only (20261005000000_people_and_contracts.sql),
 * because a contract carries pay. Every function here checks people:read or
 * people:write first, or that the reader is the person the record is about,
 * and only then reads with the service role.
 *
 * After any change to a contract's status the database's daily job runs at
 * once, so a contract signed to start today is active today and a resignation
 * with a past last day takes effect now rather than tomorrow morning.
 */

const db = () => supabaseAdmin();
const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
// The fingerprint of what is signed: the wording, and the special notes when
// there are any (so a contract without notes keeps the fingerprint it had).
const hashBody = (body: string, notes?: string | null) => {
  const signed = notes?.trim() ? `${body}\n\nSpecial notes:\n${notes.trim()}` : body;
  return createHash("sha256").update(signed.replace(/\r\n/g, "\n")).digest("hex");
};

function canReadPeople(user: SessionUser) {
  return canAny(user, PERMISSIONS.PEOPLE_READ, PERMISSIONS.PEOPLE_WRITE);
}

async function tick() {
  const { error } = await db().rpc("people_contract_tick");
  if (error) throw new Error(`Contracts could not be brought up to date: ${error.message}`);
}

async function audit(entityType: string, entityId: string, fieldName: string, oldValue: string | null, newValue: string | null, actorId: string) {
  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType, entityId, fieldName, oldValue, newValue,
    changedById: actorId, source: "UI", changedAt: now(),
  });
}

function refresh(staffId: string, contractId?: string) {
  revalidatePath("/people");
  revalidatePath(`/people/${staffId}`);
  if (contractId) revalidatePath(`/people/contracts/${contractId}`);
}

async function nextNumber(sequence: string): Promise<string> {
  const { data, error } = await db().rpc("next_sequence_number", { p_entity_type: sequence });
  if (error) throw new Error(error.message);
  return data as string;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const url = z.preprocess(blank, z.string().trim().max(500).url("Enter the full address, starting https://").refine((v) => /^https?:\/\//.test(v), "Enter the full address, starting https://").nullable().optional());
const date = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.").nullable().optional());
const uuid = z.preprocess(blank, z.string().uuid().nullable().optional());

const educationSchema = z.object({
  degree: z.string().trim().min(1, "Name the degree or certificate.").max(150),
  field: z.string().trim().max(150).optional(),
  institution: z.string().trim().min(1, "Name the institution.").max(200),
  startYear: z.string().trim().max(10).optional(),
  endYear: z.string().trim().max(10).optional(),
  grade: z.string().trim().max(50).optional(),
});

const experienceSchema = z.object({
  company: z.string().trim().min(1, "Name the company.").max(200),
  title: z.string().trim().min(1, "Name the position.").max(150),
  startDate: z.string().trim().max(20).optional(),
  endDate: z.string().trim().max(20).optional(),
  summary: z.string().trim().max(2000).optional(),
});

const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter their name.").max(150),
  fatherName: text(150),
  nationalId: text(30),
  dateOfBirth: date,
  gender: text(20),
  maritalStatus: text(20),
  personalEmail: z.preprocess(blank, z.string().trim().email("Enter a valid email, or leave it empty.").max(255).nullable().optional()),
  phone: text(50),
  address: text(500),
  city: text(100),
  country: text(100),
  emergencyContactName: text(150),
  emergencyContactRelation: text(60),
  emergencyContactPhone: text(50),
  linkedinUrl: url,
  githubUrl: url,
  portfolioUrl: url,
  skills: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
  education: z.array(educationSchema).max(20).default([]),
  experience: z.array(experienceSchema).max(30).default([]),
  notes: text(4000),
});
export type ProfileInput = z.input<typeof profileSchema>;

const termsSchema = z
  .object({
    contractType: z.enum(CONTRACT_TYPES),
    tenureMonths: z.coerce.number().int().min(1, "Choose a tenure.").max(36).default(12),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the start date."),
    endDate: date,
    jobTitle: z.string().trim().min(1, "Enter the job title.").max(150),
    departmentId: uuid,
    reportsToUserId: uuid,
    roleId: uuid,
    teamIds: z.array(z.string().uuid()).max(20).default([]),
    hoursPerWeek: z.preprocess(blank, z.coerce.number().min(1).max(80).nullable().optional()),
    payBasis: z.enum(PAY_BASES),
    payAmount: z.preprocess(blank, z.coerce.number().min(0).max(1e12).nullable().optional()),
    currencyCode: z.preprocess(blank, z.string().length(3).nullable().optional()),
    benefits: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    otherTerms: text(4000),
    noticeDays: z.coerce.number().int().min(0).max(180).default(14),
    templateId: uuid,
    // Co-founder agreements.
    equityPercent: z.preprocess(blank, z.coerce.number().min(0).max(100).nullable().optional()),
    responsibilities: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    vestingMonths: z.preprocess(blank, z.coerce.number().int().min(1).max(120).nullable().optional()),
    cliffMonths: z.preprocess(blank, z.coerce.number().int().min(0).max(60).nullable().optional()),
    capitalAmount: z.preprocess(blank, z.coerce.number().min(0).max(1000000000000).nullable().optional()),
    capitalCurrency: z.preprocess(blank, z.string().length(3).nullable().optional()),
    profitSharePercent: z.preprocess(blank, z.coerce.number().min(0).max(100).nullable().optional()),
  })
  .superRefine((v, ctx) => {
    if (v.contractType === "COFOUNDER") {
      if (!v.equityPercent || v.equityPercent <= 0) ctx.addIssue({ code: "custom", path: ["equityPercent"], message: "Enter the co-founder's equity, more than 0%." });
      if (!v.responsibilities.length) ctx.addIssue({ code: "custom", path: ["responsibilities"], message: "Tick at least one area they are responsible for." });
      if (v.vestingMonths && v.cliffMonths != null && v.cliffMonths > v.vestingMonths) ctx.addIssue({ code: "custom", path: ["cliffMonths"], message: "The cliff cannot be longer than the vesting period." });
      if (v.capitalAmount && !v.capitalCurrency) ctx.addIssue({ code: "custom", path: ["capitalCurrency"], message: "Choose the currency of the capital invested." });
    }
    if (v.payBasis !== "NONE" && (v.payAmount == null || !v.currencyCode)) {
      ctx.addIssue({ code: "custom", path: ["payAmount"], message: "Enter the amount and currency, or choose No pay." });
    }
    if (v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "The end date is before the start date." });
    }
  });
export type TermsInput = z.input<typeof termsSchema>;

function invalid(error: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { ok: false, error: error.issues[0]?.message ?? "Check the highlighted fields.", fieldErrors };
}

/**
 * Terms as the columns store them: a permanent contract is always a year, a
 * co-founder agreement has no end, and only a co-founder agreement keeps the
 * equity fields.
 */
function termsRow(t: z.infer<typeof termsSchema>) {
  const cofounder = t.contractType === "COFOUNDER";
  const tenureMonths = cofounder ? null : t.contractType === "PERMANENT" ? 12 : t.tenureMonths;
  const endDate = cofounder ? null : t.contractType === "PERMANENT" || !t.endDate ? termEndDate(t.startDate, tenureMonths!) : t.endDate;
  const paid = t.payBasis !== "NONE";
  return {
    contractType: t.contractType,
    tenureMonths,
    startDate: t.startDate,
    endDate,
    jobTitle: t.jobTitle,
    departmentId: t.departmentId ?? null,
    reportsToUserId: t.reportsToUserId ?? null,
    roleId: t.roleId ?? null,
    teamIds: t.teamIds,
    hoursPerWeek: t.hoursPerWeek ?? null,
    payBasis: t.payBasis,
    payAmount: paid ? t.payAmount ?? null : null,
    currencyCode: paid ? t.currencyCode ?? null : null,
    benefits: t.benefits,
    otherTerms: t.otherTerms ?? null,
    noticeDays: t.noticeDays,
    templateId: t.templateId ?? null,
    equityPercent: cofounder ? t.equityPercent ?? null : null,
    responsibilities: cofounder ? t.responsibilities : [],
    vestingMonths: cofounder ? t.vestingMonths ?? null : null,
    cliffMonths: cofounder && t.vestingMonths ? t.cliffMonths ?? null : null,
    capitalAmount: cofounder && t.capitalAmount ? t.capitalAmount : null,
    capitalCurrency: cofounder && t.capitalAmount ? t.capitalCurrency ?? null : null,
    profitSharePercent: cofounder ? t.profitSharePercent ?? null : null,
  };
}

async function checkTerms(t: ReturnType<typeof termsRow>, staffUserId: string | null): Promise<string | null> {
  if (t.reportsToUserId && staffUserId && t.reportsToUserId === staffUserId) return "Someone cannot report to themselves.";
  const checks = await Promise.all([
    t.departmentId ? db().from("department").select("id").eq("id", t.departmentId).eq("active", true).maybeSingle() : null,
    t.reportsToUserId ? db().from("app_user").select("id").eq("id", t.reportsToUserId).eq("status", "ACTIVE").is("partnerId", null).is("deletedAt", null).maybeSingle() : null,
    t.roleId ? db().from("security_role").select("id, name").eq("id", t.roleId).eq("active", true).maybeSingle() : null,
    t.teamIds.length ? db().from("team").select("id").in("id", t.teamIds).is("deletedAt", null) : null,
  ]);
  if (checks[0] && !checks[0].data) return "Choose an active department.";
  if (checks[1] && !checks[1].data) return "Choose an active colleague to report to.";
  if (checks[2] && (!checks[2].data || ["Partner", "Customer"].includes(String(checks[2].data.name)))) return "Choose a staff role.";
  if (checks[3] && (checks[3].data ?? []).length !== t.teamIds.length) return "One of the teams no longer exists.";
  return null;
}

// ---------------------------------------------------------------------------
// The contract text
// ---------------------------------------------------------------------------

async function buildBody(contract: ReturnType<typeof termsRow> & { contractNumber: string }, staff: Record<string, unknown>, templateBody?: string): Promise<{ body: string; templateId: string | null }> {
  let template = templateBody;
  let templateId = contract.templateId;
  if (template === undefined) {
    const query = contract.templateId
      ? db().from("contract_template").select("id, body").eq("id", contract.templateId).maybeSingle()
      : db().from("contract_template").select("id, body").eq("contractType", contract.contractType).eq("active", true).order("createdAt").limit(1).maybeSingle();
    const { data } = await query;
    template = (data?.body as string) ?? "";
    templateId = (data?.id as string) ?? null;
  }
  const [company, department, manager] = await Promise.all([
    db().from("company_setting").select("companyName").maybeSingle(),
    contract.departmentId ? db().from("department").select("name").eq("id", contract.departmentId).maybeSingle() : null,
    contract.reportsToUserId ? db().from("app_user").select("fullName").eq("id", contract.reportsToUserId).maybeSingle() : null,
  ]);
  const body = fillContract(template, {
    companyName: (company.data?.companyName as string) ?? "BabulTech",
    contractNumber: contract.contractNumber,
    today: contractDate(karachiToday()),
    fullName: staff.fullName as string,
    fatherName: staff.fatherName as string | null,
    nationalId: staff.nationalId as string | null,
    address: [staff.address, staff.city, staff.country].filter(Boolean).join(", "),
    jobTitle: contract.jobTitle,
    department: (department?.data?.name as string) ?? null,
    reportsTo: (manager?.data?.fullName as string) ?? null,
    contractType: CONTRACT_TYPE_LABELS[contract.contractType as ContractType],
    tenure: tenureLabel(contract.tenureMonths),
    startDate: contractDate(contract.startDate),
    endDate: contract.endDate ? contractDate(contract.endDate) : "no fixed end date",
    hoursPerWeek: contract.hoursPerWeek != null ? String(contract.hoursPerWeek) : null,
    pay: payLabel(contract.payBasis, contract.payAmount, contract.currencyCode),
    benefits: benefitLines(contract.benefits),
    equity: percentLabel(contract.equityPercent),
    responsibilities: benefitLines(contract.responsibilities),
    vesting: vestingLabel(contract.vestingMonths, contract.cliffMonths),
    capital: capitalLabel(contract.capitalAmount, contract.capitalCurrency),
    profitShare: percentLabel(contract.profitSharePercent, "in proportion to equity"),
    noticeDays: String(contract.noticeDays),
    otherTerms: contract.otherTerms ?? "None.",
  });
  return { body, templateId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  profileNumber: string;
  fullName: string;
  status: string;
  userId: string | null;
  personalEmail: string | null;
  phone: string | null;
  current: {
    id: string; contractNumber: string; contractType: string; status: string;
    jobTitle: string; startDate: string; endDate: string | null; lastWorkingDay: string | null;
  } | null;
}

export async function listPeople(filters: { search?: string; status?: string; type?: string; ending?: string } = {}): Promise<PersonRow[]> {
  const me = await requireUser();
  if (!canReadPeople(me)) return [];
  let query = db().from("staff_profile")
    .select("id, profileNumber, fullName, status, userId, personalEmail, phone, contracts:employment_contract ( id, contractNumber, contractType, status, jobTitle, startDate, endDate, lastWorkingDay, deletedAt )")
    .is("deletedAt", null)
    .order("fullName").limit(500);
  if (filters.search) {
    const term = filters.search.replace(/[%_,()]/g, " ").trim();
    if (term) query = query.or(`fullName.ilike.%${term}%,profileNumber.ilike.%${term}%,personalEmail.ilike.%${term}%`);
  }
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const today = karachiToday();
  const rank = (s: string) => ({ ACTIVE: 0, TERMINATED: 1, RESIGNED: 1, SIGNED: 2, EMPLOYEE_SIGNED: 3, SENT: 4, DRAFT: 5 } as Record<string, number>)[s] ?? 9;
  let rows: PersonRow[] = (data ?? []).map((p) => {
    const contracts = ((p.contracts ?? []) as (PersonRow["current"] & { deletedAt?: string | null })[]).filter((c) => c && c.status !== "CANCELLED" && !c.deletedAt);
    const live = contracts
      .filter((c) => !["ENDED", "RENEWED", "CONVERTED"].includes(c!.status) && !(["TERMINATED", "RESIGNED"].includes(c!.status) && (c!.lastWorkingDay ?? "") < today))
      .sort((a, b) => rank(a!.status) - rank(b!.status) || b!.startDate.localeCompare(a!.startDate));
    const latest = [...contracts].sort((a, b) => b!.startDate.localeCompare(a!.startDate))[0] ?? null;
    return { ...(p as never as PersonRow), current: live[0] ?? latest };
  });
  if (filters.type) rows = rows.filter((r) => r.current?.contractType === filters.type);
  if (filters.ending) {
    const limit = Number(filters.ending) || 30;
    rows = rows.filter((r) => r.current?.status === "ACTIVE" && daysUntil(r.current.endDate, today) <= limit);
  }
  return rows;
}

export async function getHiringOptions() {
  const me = await requireUser();
  if (!canReadPeople(me)) throw new Error("You do not have access to People.");
  const [departments, users, roles, teams, currencies, benefits, templates, areas, equity] = await Promise.all([
    db().from("department").select("id, name").eq("active", true).is("deletedAt", null).order("name"),
    db().from("app_user").select("id, fullName, jobTitle, email").eq("status", "ACTIVE").is("partnerId", null).is("deletedAt", null).or("userType.is.null,userType.eq.INTERNAL").order("fullName"),
    db().from("security_role").select("id, name, description, dataScope").eq("active", true).not("name", "in", "(Partner,Customer)").order("name"),
    db().from("team").select("id, name, teamType").eq("active", true).is("deletedAt", null).order("name"),
    db().from("currency").select("code, isBase").eq("active", true).order("isBase", { ascending: false }).order("code"),
    db().from("picklist_value").select("label").eq("picklistKey", "hire_benefit").eq("active", true).order("sortOrder"),
    db().from("contract_template").select("id, name, contractType").eq("active", true).order("name"),
    db().from("picklist_value").select("label").eq("picklistKey", "cofounder_area").eq("active", true).order("sortOrder"),
    // Equity already given: running agreements and ones being signed.
    db().from("employment_contract").select("id, equityPercent, staff:staff_profile!inner ( fullName )")
      .eq("contractType", "COFOUNDER").is("staff.deletedAt", null).is("deletedAt", null).in("status", ["DRAFT", "SENT", "EMPLOYEE_SIGNED", "SIGNED", "ACTIVE"]),
  ]);
  return {
    departments: departments.data ?? [],
    users: (users.data ?? []) as { id: string; fullName: string; jobTitle: string | null; email: string }[],
    roles: roles.data ?? [],
    teams: teams.data ?? [],
    currencies: (currencies.data ?? []).map((c) => String(c.code).trim()),
    benefits: (benefits.data ?? []).map((b) => String(b.label)),
    templates: (templates.data ?? []) as { id: string; name: string; contractType: string }[],
    cofounderAreas: (areas.data ?? []).map((a) => String(a.label)),
    equityHeld: (equity.data ?? []).map((e) => ({
      contractId: e.id as string,
      fullName: (one(e.staff as never) as unknown as { fullName: string } | null)?.fullName ?? "",
      percent: Number(e.equityPercent ?? 0),
    })),
    canCreateLogins: can(me, PERMISSIONS.ADMIN),
  };
}
export type HiringOptions = Awaited<ReturnType<typeof getHiringOptions>>;

export async function getPerson(id: string) {
  const me = await requireUser();
  if (!z.string().uuid().safeParse(id).success) return null;
  const { data: staff, error: staffError } = await db().from("staff_profile").select("*, user:app_user!staff_profile_userId_fkey ( id, fullName, email, status, role:security_role ( name ) )").eq("id", id).maybeSingle();
  if (staffError) throw new Error(staffError.message);
  if (!staff || staff.deletedAt) return null;
  const isSelf = staff.userId === me.id;
  if (!canReadPeople(me) && !isSelf) return null;
  const { data: contracts } = await db().from("employment_contract")
    .select("id, contractNumber, contractType, status, jobTitle, startDate, endDate, tenureMonths, payBasis, payAmount, currencyCode, lastWorkingDay, previousContractId, signMethod, signedOn, equityPercent")
    .eq("staffId", id).is("deletedAt", null).order("startDate", { ascending: false }).order("createdAt", { ascending: false });
  const user = one(staff.user as never) as { id: string; fullName: string; email: string; status: string; role: unknown } | null;
  return {
    staff: { ...staff, user: user ? { ...user, role: one(user.role as never) as { name: string } | null } : null } as Record<string, unknown> & {
      id: string; profileNumber: string; fullName: string; status: string; userId: string | null;
      education: EducationEntry[]; experience: ExperienceEntry[]; skills: string[];
      user: { id: string; fullName: string; email: string; status: string; role: { name: string } | null } | null;
    },
    contracts: contracts ?? [],
    isSelf,
    canWrite: can(me, PERMISSIONS.PEOPLE_WRITE),
    canCreateLogins: can(me, PERMISSIONS.ADMIN),
  };
}

export async function getContract(id: string) {
  const me = await requireUser();
  if (!z.string().uuid().safeParse(id).success) return null;
  const { data: contract, error: contractError } = await db().from("employment_contract")
    .select(`*, staff:staff_profile ( id, fullName, profileNumber, userId, personalEmail, status, deletedAt ),
             department:department ( name ), reportsTo:app_user!employment_contract_reportsToUserId_fkey ( fullName ),
             role:security_role ( name ), companySigner:app_user!employment_contract_companySignedById_fkey ( fullName ),
             template:contract_template ( name )`)
    .eq("id", id).maybeSingle();
  if (contractError) throw new Error(contractError.message);
  if (!contract || contract.deletedAt) return null;
  const staff = one(contract.staff as never) as unknown as { id: string; fullName: string; profileNumber: string; userId: string | null; personalEmail: string | null; status: string; deletedAt: string | null };
  if (staff.deletedAt) return null;
  const isSelf = staff.userId === me.id;
  if (!canReadPeople(me) && !isSelf) return null;
  // The contract this one follows: a separate read, as the API does not embed
  // a table in itself.
  const [teams, successors, previous, company] = await Promise.all([
    (contract.teamIds as string[]).length ? db().from("team").select("id, name").in("id", contract.teamIds as string[]) : Promise.resolve({ data: [] }),
    db().from("employment_contract").select("id, contractNumber, contractType, status").eq("previousContractId", id).neq("status", "CANCELLED").is("deletedAt", null),
    contract.previousContractId
      ? db().from("employment_contract").select("id, contractNumber, contractType").eq("id", contract.previousContractId).maybeSingle()
      : Promise.resolve({ data: null }),
    db().from("company_setting").select("companyName").maybeSingle(),
  ]);
  return {
    contract: {
      ...contract,
      companyName: (company.data?.companyName as string | undefined) ?? "BabulTech",
      staff,
      department: one(contract.department as never) as { name: string } | null,
      reportsTo: one(contract.reportsTo as never) as { fullName: string } | null,
      role: one(contract.role as never) as { name: string } | null,
      companySigner: one(contract.companySigner as never) as { fullName: string } | null,
      template: one(contract.template as never) as { name: string } | null,
      previous: (previous.data ?? null) as { id: string; contractNumber: string; contractType: string } | null,
      teams: (teams.data ?? []) as { id: string; name: string }[],
      successors: (successors.data ?? []) as { id: string; contractNumber: string; contractType: string; status: string }[],
    } as Record<string, unknown> & {
      id: string; contractNumber: string; status: string; contractType: string; body: string; bodyHash: string | null;
      startDate: string; endDate: string | null; tenureMonths: number | null; jobTitle: string;
      equityPercent: string | null; responsibilities: string[]; vestingMonths: number | null; cliffMonths: number | null;
      capitalAmount: string | null; capitalCurrency: string | null; profitSharePercent: string | null; payBasis: string; payAmount: string | null;
      currencyCode: string | null; benefits: string[]; teamIds: string[]; noticeDays: number; hoursPerWeek: string | null;
      signTokenExpiresAt: string | null; employeeSignature: string | null; companySignature: string | null;
      employeeSignedName: string | null; employeeSignedAt: string | null; companySignedName: string | null; companySignedAt: string | null;
      companySignedTitle: string | null; companyName: string; specialNotes: string | null;
      lastWorkingDay: string | null; signMethod: string | null; signedOn: string | null;
      noticeGivenOn: string | null; endReason: string | null;
      staff: typeof staff;
      department: { name: string } | null; reportsTo: { fullName: string } | null; role: { name: string } | null;
      companySigner: { fullName: string } | null; template: { name: string } | null;
      previous: { id: string; contractNumber: string; contractType: string } | null;
      teams: { id: string; name: string }[];
      successors: { id: string; contractNumber: string; contractType: string; status: string }[];
    },
    isSelf,
    canWrite: can(me, PERMISSIONS.PEOPLE_WRITE),
    canCreateLogins: can(me, PERMISSIONS.ADMIN),
  };
}

/** The signed-in person's own profile and contracts, for My account. */
export async function getMyEmployment() {
  const me = await requireUser();
  const { data: staff } = await db().from("staff_profile").select("id, profileNumber, status").eq("userId", me.id).is("deletedAt", null).maybeSingle();
  if (!staff) return null;
  const { data: contracts } = await db().from("employment_contract")
    .select("id, contractNumber, contractType, status, startDate, endDate, jobTitle")
    .eq("staffId", staff.id).neq("status", "CANCELLED").is("deletedAt", null).order("startDate", { ascending: false });
  return { staff, contracts: contracts ?? [] };
}

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

/** The wizard's save: the profile and its first contract, as a draft. */
export async function createHire(input: { profile: ProfileInput; terms: TermsInput; userId?: string | null }): Promise<ActionResult<{ staffId: string; contractId: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const profile = profileSchema.safeParse(input.profile);
  if (!profile.success) return invalid(profile.error);
  const terms = termsSchema.safeParse(input.terms);
  if (!terms.success) return invalid(terms.error);

  // An existing login being given a profile: someone already working here.
  const userId = input.userId || null;
  if (userId) {
    if (!can(auth.user, PERMISSIONS.ADMIN)) return { ok: false, error: "Only an administrator can link a profile to an existing login." };
    const [{ data: user }, { data: taken }] = await Promise.all([
      db().from("app_user").select("id").eq("id", userId).is("partnerId", null).is("deletedAt", null).maybeSingle(),
      db().from("staff_profile").select("id").eq("userId", userId).maybeSingle(),
    ]);
    if (!user) return { ok: false, error: "Choose an existing staff login." };
    if (taken) return { ok: false, error: "That login already has a profile. If it was deleted, restore it from the recycle bin." };
  }

  const row = termsRow(terms.data);
  const problem = await checkTerms(row, userId);
  if (problem) return { ok: false, error: problem };

  try {
    const staffId = crypto.randomUUID();
    const { error: staffError } = await db().from("staff_profile").insert({
      id: staffId, profileNumber: await nextNumber(SEQUENCES.STAFF), userId,
      ...profile.data, createdById: auth.user.id, updatedAt: now(),
    });
    if (staffError) throw new Error(staffError.message);

    const contractNumber = await nextNumber(SEQUENCES.EMPLOYMENT_CONTRACT);
    const { body, templateId } = await buildBody({ ...row, contractNumber }, profile.data);
    const contractId = crypto.randomUUID();
    const { error } = await db().from("employment_contract").insert({
      id: contractId, contractNumber, staffId, ...row, templateId, body, status: "DRAFT",
      createdById: auth.user.id, updatedAt: now(),
    });
    if (error) {
      await db().from("staff_profile").delete().eq("id", staffId);
      throw new Error(error.message);
    }
    refresh(staffId, contractId);
    return { ok: true, data: { staffId, contractId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not save the hire." };
  }
}

export async function updateProfile(staffId: string, input: ProfileInput): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await db().from("staff_profile").update({ ...parsed.data, updatedAt: now() }).eq("id", staffId).select("id").maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "That profile no longer exists." };
  refresh(staffId);
  return { ok: true, data: { id: staffId } };
}

/**
 * A further contract for someone: a renewal, a conversion to employment, or a
 * fresh start after a gap. `previousContractId` says which one it follows.
 */
export async function createContract(staffId: string, input: TermsInput, previousContractId?: string | null): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = termsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { data: staff } = await db().from("staff_profile").select("*").eq("id", staffId).maybeSingle();
  if (!staff) return { ok: false, error: "That profile no longer exists." };

  if (previousContractId) {
    const { data: previous } = await db().from("employment_contract").select("id, staffId, status").eq("id", previousContractId).maybeSingle();
    if (!previous || previous.staffId !== staffId) return { ok: false, error: "The contract being renewed is not this person's." };
    if (!["ACTIVE", "ENDED", "SIGNED"].includes(previous.status)) return { ok: false, error: "Only a current or recently ended contract can be renewed or converted." };
    const { data: open } = await db().from("employment_contract").select("contractNumber").eq("previousContractId", previousContractId).neq("status", "CANCELLED").is("deletedAt", null).limit(1);
    if (open?.length) return { ok: false, error: `${open[0].contractNumber} already follows this contract. Open it, or cancel it first.` };
  }
  const row = termsRow(parsed.data);
  const problem = await checkTerms(row, staff.userId);
  if (problem) return { ok: false, error: problem };

  const contractNumber = await nextNumber(SEQUENCES.EMPLOYMENT_CONTRACT);
  const { body, templateId } = await buildBody({ ...row, contractNumber }, staff);
  const id = crypto.randomUUID();
  const { error } = await db().from("employment_contract").insert({
    id, contractNumber, staffId, previousContractId: previousContractId ?? null, ...row, templateId, body,
    status: "DRAFT", createdById: auth.user.id, updatedAt: now(),
  });
  if (error) return { ok: false, error: error.message };
  refresh(staffId, id);
  return { ok: true, data: { id } };
}

async function loadForChange(id: string, allowed: string[]) {
  const { data } = await db().from("employment_contract").select("*, staff:staff_profile ( * )").eq("id", id).is("deletedAt", null).maybeSingle();
  if (!data) return { error: "That contract no longer exists." } as const;
  if (!allowed.includes(data.status)) return { error: `This contract is ${String(data.status).toLowerCase().replace(/_/g, " ")}, so that cannot be done.` } as const;
  return { contract: data, staff: one(data.staff as never) as unknown as Record<string, unknown> & { id: string; userId: string | null; fullName: string; personalEmail: string | null } } as const;
}

/** Changes a draft's terms, and rebuilds its text from the template unless told not to. */
export async function updateContractTerms(id: string, input: TermsInput, rebuildText = true): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = termsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const loaded = await loadForChange(id, ["DRAFT"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const row = termsRow(parsed.data);
  const problem = await checkTerms(row, loaded.staff.userId);
  if (problem) return { ok: false, error: problem };
  const patch: Record<string, unknown> = { ...row, updatedAt: now() };
  if (rebuildText) {
    const built = await buildBody({ ...row, contractNumber: loaded.contract.contractNumber }, loaded.staff);
    patch.body = built.body;
    patch.templateId = built.templateId;
  }
  const { error } = await db().from("employment_contract").update(patch).eq("id", id).eq("status", "DRAFT");
  if (error) return { ok: false, error: error.message };
  refresh(loaded.staff.id, id);
  return { ok: true, data: { id } };
}

export async function updateContractText(id: string, body: string, specialNotes?: string | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = z.string().trim().min(20, "The contract text is too short.").max(100_000).safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const notes = z.string().max(4000, "Keep the special notes under 4,000 characters.").safeParse(specialNotes ?? "");
  if (!notes.success) return { ok: false, error: notes.error.issues[0].message };
  const loaded = await loadForChange(id, ["DRAFT"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const { error } = await db().from("employment_contract").update({
    body: parsed.data, specialNotes: notes.data.trim() || null, updatedAt: now(),
  }).eq("id", id).eq("status", "DRAFT");
  if (error) return { ok: false, error: error.message };
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

async function appUrl(): Promise<string> {
  const { data } = await db().from("company_setting").select("publicAppUrl").maybeSingle();
  const configured = (data?.publicAppUrl as string | null) || process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/**
 * Freezes the text and issues a signing link. The link is returned once, to
 * copy; with `email` it is also sent to their personal email. Sending again
 * replaces the previous link.
 */
export async function sendForSigning(id: string, options: { email?: boolean } = {}): Promise<ActionResult<{ url: string; emailedTo: string | null; expiresAt: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const loaded = await loadForChange(id, ["DRAFT", "SENT"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const { contract, staff } = loaded;
  if (options.email && !staff.personalEmail) return { ok: false, error: "Add their personal email to the profile first, or copy the link instead." };
  if (options.email && !process.env.RESEND_API_KEY) return { ok: false, error: "Email is not set up. Copy the link and send it yourself." };

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SIGNING_LINK_DAYS * 86_400_000).toISOString();
  const { error } = await db().from("employment_contract").update({
    status: "SENT", signTokenHash: hashToken(token), signTokenExpiresAt: expiresAt,
    bodyHash: hashBody(contract.body, contract.specialNotes), sentAt: now(), updatedAt: now(),
  }).eq("id", id).in("status", ["DRAFT", "SENT"]);
  if (error) return { ok: false, error: error.message };
  if (contract.status === "DRAFT") await audit("EmploymentContract", id, "status", "DRAFT", "SENT", auth.user.id);

  const link = `${await appUrl()}/sign/${token}`;
  let emailedTo: string | null = null;
  if (options.email && staff.personalEmail) {
    const { data: settings } = await db().from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
    const branding = brandingFromSettings(emailSettingsFromRow(settings));
    // Wording from Settings → System emails, or the built-in default.
    const template = await renderSystemEmail("CONTRACT_SIGNING", {
      fullName: String(staff.fullName), firstName: String(staff.fullName).split(" ")[0], companyName: branding.companyName,
      contractNumber: String(contract.contractNumber), contractType: CONTRACT_TYPE_LABELS[contract.contractType as ContractType].toLowerCase(),
      position: String(contract.jobTitle ?? ""), linkDays: String(SIGNING_LINK_DAYS),
    });
    const { html, text: plain } = renderDocumentEmail({
      branding,
      documentTitle: `Your contract ${contract.contractNumber}`,
      message: "",
      messageHtml: template.messageHtml,
      summary: [
        { label: "Position", value: contract.jobTitle },
        { label: "From", value: contractDate(contract.startDate) },
        { label: "To", value: contract.endDate ? contractDate(contract.endDate) : "No end date" },
      ],
      action: { label: "Read and sign", url: link },
      senderName: auth.user.fullName,
      senderTitle: auth.user.jobTitle,
    });
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sent = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>",
      to: staff.personalEmail, replyTo: process.env.EMAIL_REPLY_TO ?? auth.user.email,
      subject: template.subject, html, text: plain,
    });
    if (sent.error) return { ok: false, error: `The link was created but the email failed: ${sent.error.message}. Copy the link instead.` };
    emailedTo = staff.personalEmail;
  }
  refresh(staff.id, id);
  return { ok: true, data: { url: link, emailedTo, expiresAt } };
}

/** Takes a sent contract back to draft; the link stops working. */
export async function withdrawSigning(id: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const loaded = await loadForChange(id, ["SENT"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const { error } = await db().from("employment_contract").update({
    status: "DRAFT", signTokenHash: null, signTokenExpiresAt: null, bodyHash: null, updatedAt: now(),
  }).eq("id", id).eq("status", "SENT");
  if (error) return { ok: false, error: error.message };
  await audit("EmploymentContract", id, "status", "SENT", "DRAFT", auth.user.id);
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

const signatureSchema = z.object({
  name: z.string().trim().min(2, "Type your full name.").max(150),
  signature: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Draw your signature.").max(300_000, "That signature is too large. Clear it and draw it again."),
});

export async function signForCompany(id: string, input: { name: string; signature: string; title?: string | null }): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = signatureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const loaded = await loadForChange(id, ["EMPLOYEE_SIGNED"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  if (loaded.staff.userId === auth.user.id) return { ok: false, error: "Someone else has to sign your own contract for the company." };
  const { error } = await db().from("employment_contract").update({
    status: "SIGNED", signMethod: "DIGITAL", companySignedById: auth.user.id, companySignedName: parsed.data.name,
    companySignedTitle: (input.title ?? auth.user.jobTitle ?? "").trim().slice(0, 150) || null,
    companySignature: parsed.data.signature, companySignedAt: now(), signedOn: karachiToday(),
    signTokenHash: null, updatedAt: now(),
  }).eq("id", id).eq("status", "EMPLOYEE_SIGNED");
  if (error) return { ok: false, error: error.message };
  await audit("EmploymentContract", id, "status", "EMPLOYEE_SIGNED", "SIGNED", auth.user.id);
  await tick();
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

/** Signed on paper: the scan goes on the contract as a document. */
export async function markSignedByHand(id: string, input: { signedOn: string }): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = z.object({ signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date it was signed.") }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (parsed.data.signedOn > karachiToday()) return { ok: false, error: "The signing date cannot be in the future." };
  const loaded = await loadForChange(id, ["DRAFT", "SENT", "EMPLOYEE_SIGNED"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const { error } = await db().from("employment_contract").update({
    status: "SIGNED", signMethod: "MANUAL", signedOn: parsed.data.signedOn, bodyHash: hashBody(loaded.contract.body, loaded.contract.specialNotes),
    signTokenHash: null, signTokenExpiresAt: null, companySignedById: auth.user.id, updatedAt: now(),
  }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await audit("EmploymentContract", id, "status", loaded.contract.status, "SIGNED", auth.user.id);
  await tick();
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

export async function cancelContract(id: string, reason: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const why = z.string().trim().min(3, "Say why it is cancelled.").max(1000).safeParse(reason);
  if (!why.success) return { ok: false, error: why.error.issues[0].message };
  const loaded = await loadForChange(id, CANCELLABLE_STATUSES);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  const { error } = await db().from("employment_contract").update({
    status: "CANCELLED", endReason: why.data, signTokenHash: null, signTokenExpiresAt: null,
    closedById: auth.user.id, closedAt: now(), updatedAt: now(),
  }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await audit("EmploymentContract", id, "status", loaded.contract.status, "CANCELLED", auth.user.id);
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

/**
 * Ending a running contract early: the company terminates it, or the person
 * resigns. Their login stays on until the last working day.
 */
export async function endContractEarly(id: string, input: { kind: "TERMINATED" | "RESIGNED"; lastWorkingDay: string; noticeGivenOn?: string | null; reason: string }): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = z.object({
    kind: z.enum(["TERMINATED", "RESIGNED"]),
    lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose their last working day."),
    noticeGivenOn: date,
    reason: z.string().trim().min(3, "Give the reason.").max(2000),
  }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const loaded = await loadForChange(id, ["ACTIVE"]);
  if ("error" in loaded) return { ok: false, error: loaded.error! };
  if (loaded.staff.userId === auth.user.id) return { ok: false, error: "Someone else has to record the end of your own contract." };
  if (parsed.data.lastWorkingDay < loaded.contract.startDate) return { ok: false, error: "The last working day is before the contract started." };
  if (loaded.contract.endDate && parsed.data.lastWorkingDay > loaded.contract.endDate) return { ok: false, error: "The last working day is after the contract ends anyway. Let it end instead." };

  const { error } = await db().from("employment_contract").update({
    status: parsed.data.kind, lastWorkingDay: parsed.data.lastWorkingDay, noticeGivenOn: parsed.data.noticeGivenOn ?? null,
    endReason: parsed.data.reason, closedById: auth.user.id, closedAt: now(), updatedAt: now(),
  }).eq("id", id).eq("status", "ACTIVE");
  if (error) return { ok: false, error: error.message };
  // A renewal waiting to start would otherwise start anyway.
  await db().from("employment_contract").update({
    status: "CANCELLED", endReason: `Cancelled because ${loaded.contract.contractNumber} ended early.`,
    signTokenHash: null, closedById: auth.user.id, closedAt: now(), updatedAt: now(),
  }).eq("previousContractId", id).in("status", CANCELLABLE_STATUSES);
  await audit("EmploymentContract", id, "status", "ACTIVE", parsed.data.kind, auth.user.id);
  await tick();
  refresh(loaded.staff.id, id);
  return { ok: true, data: undefined };
}

// --- The public signing page ------------------------------------------------

async function contractByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const { data } = await db().from("employment_contract")
    .select("id, contractNumber, contractType, status, body, specialNotes, bodyHash, jobTitle, startDate, endDate, signTokenExpiresAt, employeeSignedName, employeeSignedAt, deletedAt, staff:staff_profile ( id, fullName )")
    .eq("signTokenHash", hashToken(token)).maybeSingle();
  if (!data || data.deletedAt) return null;
  if (data.signTokenExpiresAt && Date.parse(`${data.signTokenExpiresAt}Z`) < Date.now()) return null;
  return { ...data, staff: one(data.staff as never) as unknown as { id: string; fullName: string } };
}

/** What a signing link shows. Unknown, expired and withdrawn links all return null. */
export async function getSigningContext(token: string) {
  const contract = await contractByToken(token);
  if (!contract || !["SENT", "EMPLOYEE_SIGNED"].includes(contract.status)) return null;
  const { data: company } = await db().from("company_setting").select("companyName").maybeSingle();
  return {
    contractNumber: contract.contractNumber as string,
    contractType: CONTRACT_TYPE_LABELS[contract.contractType as ContractType],
    status: contract.status as string,
    body: contract.body as string,
    specialNotes: (contract.specialNotes as string | null) ?? null,
    fullName: contract.staff.fullName,
    jobTitle: contract.jobTitle as string,
    startDate: contract.startDate as string,
    endDate: contract.endDate as string | null,
    signedName: contract.employeeSignedName as string | null,
    signedAt: contract.employeeSignedAt as string | null,
    companyName: (company?.companyName as string) ?? "BabulTech",
  };
}

export async function signAsEmployee(token: string, input: { name: string; signature: string; agree: boolean }): Promise<ActionResult> {
  const parsed = signatureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (!input.agree) return { ok: false, error: "Tick the box to confirm you have read and agree to the contract." };
  const contract = await contractByToken(token);
  if (!contract || contract.status !== "SENT") return { ok: false, error: "This signing link is no longer valid." };
  // The words they read are the words that were sent.
  if (contract.bodyHash && contract.bodyHash !== hashBody(contract.body as string, contract.specialNotes as string | null)) return { ok: false, error: "This contract changed after it was sent. Ask for a new link." };
  const h = await headers();
  const { data, error } = await db().from("employment_contract").update({
    status: "EMPLOYEE_SIGNED", employeeSignedName: parsed.data.name, employeeSignature: parsed.data.signature,
    employeeSignedAt: now(), employeeSignedIp: (h.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null,
    employeeSignedAgent: (h.get("user-agent") ?? "").slice(0, 300) || null, updatedAt: now(),
  }).eq("id", contract.id).eq("status", "SENT").select("id").maybeSingle();
  if (error) return { ok: false, error: "Your signature could not be saved. Try again." };
  if (!data) return { ok: false, error: "This contract has already been signed." };
  await db().from("audit_history").insert({
    id: crypto.randomUUID(), entityType: "EmploymentContract", entityId: contract.id, fieldName: "status",
    oldValue: "SENT", newValue: "EMPLOYEE_SIGNED", changedById: null, source: "SIGNING_LINK", changedAt: now(),
  });
  // Whoever manages contracts is told it is their turn.
  const { data: holders } = await db().rpc("app_users_holding", { p_permission: "people:write" });
  await Promise.all(((holders ?? []) as unknown[]).map((row) => db().rpc("notify_user", {
    p_user: typeof row === "string" ? row : Object.values(row as object)[0],
    p_kind: "CONTRACT_SIGNED",
    p_title: `${contract.staff.fullName} signed ${contract.contractNumber}`,
    p_body: "It now needs signing for the company.", p_link: `/people/contracts/${contract.id}`,
    p_entity_type: "EmploymentContract", p_entity_id: contract.id, p_dedupe: `contract-signed:${contract.id}`,
  })));
  revalidatePath(`/people/contracts/${contract.id}`);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Logins
// ---------------------------------------------------------------------------

/** The contract a login is set up from: the running one, else the latest. */
async function contractForLogin(staffId: string) {
  const { data } = await db().from("employment_contract").select("*").eq("staffId", staffId).neq("status", "CANCELLED").is("deletedAt", null)
    .order("startDate", { ascending: false }).limit(10);
  const rows = data ?? [];
  return rows.find((c) => c.status === "ACTIVE") ?? rows.find((c) => ["SIGNED", "EMPLOYEE_SIGNED", "SENT", "DRAFT"].includes(c.status)) ?? rows[0] ?? null;
}

/**
 * Creates the CRM login for a hire, set up from their contract: role, job
 * title, department, who they report to, teams, and an hourly cost for
 * project costing when it can be worked out in the base currency.
 */
export async function createLoginForPerson(staffId: string, input: { email: string; password: string; roleId?: string | null; reportsToUserId?: string | null }): Promise<ActionResult<{ userId: string; welcome: { emailedTo: string | null; emailError: string | null } }>> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const { data: staff } = await db().from("staff_profile").select("*").eq("id", staffId).maybeSingle();
  if (!staff) return { ok: false, error: "That profile no longer exists." };
  if (staff.userId) return { ok: false, error: "They already have a login." };
  const contract = await contractForLogin(staffId);
  if (!contract) return { ok: false, error: "Prepare their contract first." };
  const roleId = input.roleId || contract.roleId;
  if (!roleId) return { ok: false, error: "Choose the role their login gets.", fieldErrors: { roleId: ["Choose a role."] } };

  // Who they report to: as chosen on the form, else the contract's person if
  // they are still active. A manager switched off since the contract was made
  // no longer holds the login back.
  const chosen = input.reportsToUserId === undefined ? contract.reportsToUserId : input.reportsToUserId || null;
  const reportsTo = chosen && (await activeColleague(chosen)) ? chosen : null;
  if (input.reportsToUserId && !reportsTo) return { ok: false, error: "Choose an active colleague for them to report to.", fieldErrors: { reportsToUserId: ["Choose an active colleague."] } };

  const { data: base } = await db().from("currency").select("code").eq("isBase", true).maybeSingle();
  const cost = contract.currencyCode && base && String(base.code).trim() === String(contract.currencyCode).trim()
    ? hourlyCost({ payBasis: contract.payBasis, payAmount: contract.payAmount == null ? null : Number(contract.payAmount), hoursPerWeek: contract.hoursPerWeek == null ? null : Number(contract.hoursPerWeek), tenureMonths: contract.tenureMonths })
    : null;

  const created = await createUser({
    fullName: staff.fullName, email: input.email, password: input.password, roleId,
    notificationEmail: "", employeeNumber: staff.profileNumber, jobTitle: contract.jobTitle,
    phone: staff.phone ?? null, departmentId: contract.departmentId ?? null, managerUserId: reportsTo,
    partnerId: null, status: "ACTIVE", costRate: cost, defaultBillingRate: null,
  });
  if (!created.ok) return created;
  const userId = created.data.id;
  await db().from("staff_profile").update({ userId, updatedAt: now() }).eq("id", staffId);
  if ((contract.teamIds as string[]).length) {
    await db().from("team_member").insert((contract.teamIds as string[]).map((teamId) => ({
      id: crypto.randomUUID(), teamId, userId, startDate: contract.startDate, updatedAt: now(),
    })));
  }
  // Not started yet: the login waits, and the daily job switches it on with the contract.
  if (!["ACTIVE"].includes(contract.status) && contract.startDate > karachiToday()) {
    await db().from("app_user").update({ status: "INACTIVE", updatedAt: now() }).eq("id", userId);
  }
  refresh(staffId);
  revalidatePath("/users");
  return { ok: true, data: { userId, welcome: created.data.welcome } };
}

/** Gives someone already working here, with a login, their profile. */
export async function linkLogin(staffId: string, userId: string): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.ADMIN);
  if (!auth.ok) return auth;
  const [{ data: user }, { data: taken }] = await Promise.all([
    db().from("app_user").select("id").eq("id", userId).is("partnerId", null).is("deletedAt", null).maybeSingle(),
    db().from("staff_profile").select("id").eq("userId", userId).maybeSingle(),
  ]);
  if (!user) return { ok: false, error: "Choose an existing staff login." };
  if (taken) return { ok: false, error: "That login already has a profile. If it was deleted, restore it from the recycle bin." };
  const { error } = await db().from("staff_profile").update({ userId, updatedAt: now() }).eq("id", staffId).is("userId", null);
  if (error) return { ok: false, error: error.message };
  refresh(staffId);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates() {
  const me = await requireUser();
  if (!canReadPeople(me)) return [];
  const { data } = await db().from("contract_template").select("*").order("contractType").order("name");
  return (data ?? []) as { id: string; name: string; contractType: string; body: string; active: boolean; updatedAt: string }[];
}

export async function saveTemplate(input: { id?: string | null; name: string; contractType: string; body: string; active: boolean }): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const parsed = z.object({
    id: uuid,
    name: z.string().trim().min(2, "Name the template.").max(120),
    contractType: z.enum(CONTRACT_TYPES),
    body: z.string().trim().min(20, "Write the contract text.").max(100_000),
    active: z.boolean(),
  }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { id, ...values } = parsed.data;
  const result = id
    ? await db().from("contract_template").update({ ...values, updatedAt: now() }).eq("id", id).select("id").single()
    : await db().from("contract_template").insert({ ...values, updatedAt: now() }).select("id").single();
  if (result.error) return { ok: false, error: result.error.message };
  revalidatePath("/people/templates");
  return { ok: true, data: { id: result.data.id as string } };
}

/** For the renew and convert forms: where the next term would start. */
export async function suggestedNextStart(contractId: string): Promise<string | null> {
  const auth = await authorizeAny(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return null;
  const { data } = await db().from("employment_contract").select("endDate").eq("id", contractId).maybeSingle();
  return data?.endDate ? dayAfter(data.endDate as string) : null;
}

/** Why a contract cannot be deleted now, or null if an administrator may. */
export async function contractDeleteBlocker(id: string): Promise<string | null> {
  const auth = await authorize(PERMISSIONS.RECORD_DELETE);
  if (!auth.ok) return "Only the Super Admin can delete a contract.";
  const { data } = await db().rpc("recycle_hard_blocker", { p_entity_type: "EmploymentContract", p_id: id });
  return (data as string | null) ?? null;
}

// ---------------------------------------------------------------------------
// Who someone reports to
// ---------------------------------------------------------------------------

async function activeColleague(userId: string): Promise<boolean> {
  const { data } = await db().from("app_user").select("id").eq("id", userId).eq("status", "ACTIVE")
    .is("partnerId", null).is("deletedAt", null).or("userType.is.null,userType.eq.INTERNAL").maybeSingle();
  return Boolean(data);
}

/**
 * Who a person reports to now, and who they could report to. Their login's
 * manager when they have one, else their current contract's.
 */
export async function getReportingLine(staffId: string) {
  const me = await requireUser();
  if (!canReadPeople(me)) return null;
  const { data: staff } = await db().from("staff_profile").select("id, userId").eq("id", staffId).is("deletedAt", null).maybeSingle();
  if (!staff) return null;
  let currentId: string | null = null;
  if (staff.userId) {
    currentId = ((await db().from("app_user").select("managerUserId").eq("id", staff.userId).maybeSingle()).data?.managerUserId as string | null) ?? null;
  }
  if (!currentId) {
    const contract = await contractForLogin(staffId);
    currentId = (contract?.reportsToUserId as string | null) ?? null;
  }
  const [current, options] = await Promise.all([
    currentId ? db().from("app_user").select("id, fullName, email, status").eq("id", currentId).maybeSingle() : Promise.resolve({ data: null }),
    db().from("app_user").select("id, fullName, jobTitle").eq("status", "ACTIVE").is("partnerId", null).is("deletedAt", null)
      .or("userType.is.null,userType.eq.INTERNAL").order("fullName"),
  ]);
  const cur = current.data as { id: string; fullName: string; email: string; status: string } | null;
  return {
    current: cur ? { id: cur.id, fullName: cur.fullName, email: cur.email, active: cur.status === "ACTIVE" } : null,
    options: ((options.data ?? []) as { id: string; fullName: string; jobTitle: string | null }[]).filter((u) => u.id !== staff.userId),
  };
}

/**
 * Changes who someone reports to: on their login (which is what a Lead role's
 * view of the team follows) and on their current contracts. The wording of a
 * contract already sent or signed is not changed; it records who it was then.
 */
export async function setReportsTo(staffId: string, reportsToUserId: string | null): Promise<ActionResult> {
  const auth = await authorize(PERMISSIONS.PEOPLE_WRITE);
  if (!auth.ok) return auth;
  const { data: staff } = await db().from("staff_profile").select("id, userId").eq("id", staffId).is("deletedAt", null).maybeSingle();
  if (!staff) return { ok: false, error: "That profile no longer exists." };
  const target = reportsToUserId || null;
  if (target) {
    if (target === staff.userId) return { ok: false, error: "Someone cannot report to themselves." };
    if (!(await activeColleague(target))) return { ok: false, error: "Choose an active colleague for them to report to." };
    // No loops: the new manager must not, however far up, report to this person.
    if (staff.userId) {
      let current: string | null = target;
      for (let depth = 0; current && depth < 100; depth++) {
        if (current === staff.userId) return { ok: false, error: "That would make a loop: they already manage that person, directly or further down." };
        current = ((await db().from("app_user").select("managerUserId").eq("id", current).maybeSingle()).data?.managerUserId as string | null) ?? null;
      }
    }
  }
  const at = now();
  const { error } = await db().from("employment_contract").update({ reportsToUserId: target, updatedAt: at })
    .eq("staffId", staffId).is("deletedAt", null).in("status", ["DRAFT", "SENT", "EMPLOYEE_SIGNED", "SIGNED", "ACTIVE"]);
  if (error) return { ok: false, error: error.message };
  if (staff.userId) {
    const { data: before } = await db().from("app_user").select("managerUserId").eq("id", staff.userId).maybeSingle();
    const { error: userError } = await db().from("app_user").update({ managerUserId: target, updatedAt: at }).eq("id", staff.userId);
    if (userError) return { ok: false, error: userError.message };
    await audit("User", staff.userId, "managerUserId", (before?.managerUserId as string | null) ?? null, target, auth.user.id);
  }
  await audit("StaffProfile", staffId, "reportsTo", null, target, auth.user.id);
  refresh(staffId);
  revalidatePath("/users");
  return { ok: true, data: undefined };
}
