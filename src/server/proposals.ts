"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase";
import { SEQUENCES } from "@/lib/numbering";
import { Resend } from "@/lib/mail";
import { sanitizeRichText } from "@/lib/rich-text";
import { renderDocumentEmail, emailSettingsFromRow, brandingFromSettings, EMAIL_SETTINGS_ID } from "@/lib/email-template";
import { authorize, requireUser, can, PERMISSIONS } from "@/lib/authz";
import { fillMergeFields, proposalDate, type PricingSnapshot, type ProposalSection, type TemplateSection } from "@/lib/proposals";
import { sendQuotation } from "./quotations";
import type { ActionResult } from "./partners";

/**
 * Proposals: the document a customer reads and accepts.
 *
 * A template is an offering's ordered sections: text written for that
 * template, shared blocks from the section library (About us, Terms), and the
 * pricing table. Creating a proposal copies the sections and fills in the
 * customer's details once, so what the salesperson edits is the final text.
 *
 * The pricing table is the deal's quotation - prices are never typed twice -
 * and sending the proposal sends that quotation through its own rules, so a
 * discount that needs approval still needs it. Sending freezes the text and the
 * pricing; a later change is a new version, and the old link stops accepting.
 *
 * The customer reaches a proposal only by its link. Accepting records their
 * name and signature and tells the deal owner, who accepts the quote and
 * marks the deal won.
 */

interface ProposalRow {
  id: string; proposalNumber: string; version: number; opportunityId: string; templateId: string | null; quotationId: string | null;
  title: string; sections: ProposalSection[]; status: string; validUntil: string | null; sentAt: string | null; sentTo: string | null;
  firstViewedAt: string | null; acceptedName: string | null; acceptedSignature: string | null; acceptedAt: string | null;
  acceptedIp: string | null; customerComment: string | null; createdAt: string;
}

const db = () => supabaseAdmin();
const now = () => new Date().toISOString();
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const flat = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const today = () => new Date().toISOString().slice(0, 10);

function refreshProposal(id: string, opportunityId?: string | null) {
  revalidatePath(`/proposals/${id}`);
  if (opportunityId) revalidatePath(`/opportunities/${opportunityId}`);
}

async function event(proposalId: string, kind: string, actorId: string | null, note?: string | null) {
  await db().from("proposal_event").insert({ proposalId, kind, actorId, note: note ?? null });
}

/** The deal, if the signed-in person can see it under their own row rules. */
async function visibleOpportunity(opportunityId: string) {
  const sdb = await supabaseServer();
  const { data } = await sdb.from("opportunity").select("id").eq("id", opportunityId).maybeSingle();
  return Boolean(data);
}

async function appUrl(): Promise<string> {
  const { data } = await db().from("company_setting").select("publicAppUrl").maybeSingle();
  const configured = (data?.publicAppUrl as string | null) || process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

// ---------------------------------------------------------------------------
// Section library and templates
// ---------------------------------------------------------------------------

export async function listProposalSections() {
  await requireUser();
  const { data } = await db().from("proposal_section").select("*").order("name");
  return data ?? [];
}

export async function saveProposalSection(id: string | null, input: { name: string; body: string; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "Give the section a name." };
  const body = sanitizeRichText(input.body) ?? "";
  const row = { name: name.slice(0, 120), body, active: input.active ?? true, updatedAt: now() };
  if (id) {
    const { error } = await db().from("proposal_section").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await db().from("proposal_section").insert(row).select("id").single();
    if (error) return { ok: false, error: error.message };
    id = data.id as string;
  }
  revalidatePath("/proposals/templates");
  return { ok: true, data: { id: id! } };
}

export async function listProposalTemplates(includeHidden = false) {
  await requireUser();
  let q = db().from("proposal_template").select("id, name, offeringId, validDays, active, sections, offering ( name )").order("name");
  if (!includeHidden) q = q.eq("active", true);
  const { data } = await q;
  return (data ?? []).map((t) => ({ ...t, offering: flat(t.offering) as { name: string } | null, sectionCount: ((t.sections ?? []) as unknown[]).length }));
}

export async function getProposalTemplate(id: string) {
  await requireUser();
  const { data } = await db().from("proposal_template").select("*").eq("id", id).maybeSingle();
  return data as (Record<string, unknown> & { id: string; name: string; offeringId: string | null; validDays: number; active: boolean; sections: TemplateSection[] }) | null;
}

const templateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(120),
  offeringId: z.string().uuid().nullable(),
  validDays: z.coerce.number().int().min(1, "At least one day.").max(365),
  active: z.boolean(),
  sections: z.array(z.union([
    z.object({ kind: z.literal("TEXT"), title: z.string().trim().min(1, "Every section needs a title.").max(150), body: z.string() }),
    z.object({ kind: z.literal("LIBRARY"), title: z.string().trim().min(1, "Every section needs a title.").max(150), sectionId: z.string().uuid("Choose the shared section.") }),
    z.object({ kind: z.literal("PRICING"), title: z.string().trim().min(1, "Every section needs a title.").max(150) }),
  ])).max(40),
});

export async function saveProposalTemplate(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.SALES_SETUP);
  if (!auth.ok) return auth;
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the template." };
  const d = parsed.data;
  const sections = d.sections.map((s) => (s.kind === "TEXT" ? { ...s, body: sanitizeRichText(s.body) ?? "" } : s));
  const row = { name: d.name, offeringId: d.offeringId, validDays: d.validDays, active: d.active, sections, updatedAt: now() };
  if (id) {
    const { error } = await db().from("proposal_template").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { data, error } = await db().from("proposal_template").insert(row).select("id").single();
    if (error) return { ok: false, error: error.message };
    id = data.id as string;
  }
  revalidatePath("/proposals/templates");
  return { ok: true, data: { id: id! } };
}

// ---------------------------------------------------------------------------
// Pricing from the quotation
// ---------------------------------------------------------------------------

async function pricingFor(quotationId: string | null): Promise<PricingSnapshot | null> {
  if (!quotationId) return null;
  const { data: q } = await db().from("quotation")
    .select("quoteNumber, currencyCode, subtotal, discountAmount, taxAmount, totalAmount, paymentTerms, lines:quote_line ( description, quantity, unitPrice, discountPercent, lineTotal, sortOrder )")
    .eq("id", quotationId).maybeSingle();
  if (!q) return null;
  return {
    quoteNumber: q.quoteNumber, currencyCode: q.currencyCode,
    lines: ((q.lines ?? []) as Record<string, unknown>[])
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
      .map((l) => ({ description: String(l.description), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discountPercent: l.discountPercent == null ? null : Number(l.discountPercent), lineTotal: Number(l.lineTotal) })),
    subtotal: Number(q.subtotal), discountAmount: Number(q.discountAmount), taxAmount: Number(q.taxAmount), totalAmount: Number(q.totalAmount),
    paymentTerms: (q.paymentTerms as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Proposals on a deal
// ---------------------------------------------------------------------------

export async function listProposalsFor(opportunityId: string) {
  const user = await requireUser();
  if (!can(user, PERMISSIONS.OPPORTUNITY_READ) || !(await visibleOpportunity(opportunityId))) return [];
  const { data } = await db().from("proposal")
    .select("id, proposalNumber, version, title, status, sentAt, firstViewedAt, acceptedAt, validUntil, createdAt")
    .eq("opportunityId", opportunityId).order("createdAt", { ascending: false });
  return data ?? [];
}

export async function createProposal(opportunityId: string, templateId: string | null): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return auth;
  if (!(await visibleOpportunity(opportunityId))) return { ok: false, error: "That opportunity is not yours to change." };

  const { data: opp } = await db().from("opportunity")
    .select("id, name, amount, currencyCode, stage, offeringId, accountId, account ( name ), contact:contact!opportunity_primaryContactId_fkey ( firstName, lastName ), owner:app_user!opportunity_ownerUserId_fkey ( fullName, email, jobTitle, phone ), offering ( name )")
    .eq("id", opportunityId).maybeSingle();
  if (!opp) return { ok: false, error: "That opportunity no longer exists." };
  if (["CLOSED_WON", "CLOSED_LOST"].includes(opp.stage)) return { ok: false, error: "This deal is closed." };

  let template: { id: string; name: string; validDays: number; sections: TemplateSection[] } | null = null;
  if (templateId) {
    const t = await getProposalTemplate(templateId);
    if (!t) return { ok: false, error: "That template no longer exists." };
    template = t;
  } else {
    template = { id: "", name: "Proposal", validDays: 30, sections: [
      { kind: "TEXT", title: "Introduction", body: "<p>Dear {{contact.firstName}},</p><p></p>" },
      { kind: "PRICING", title: "Pricing" },
    ] };
  }

  const { data: library } = await db().from("proposal_section").select("id, body");
  const libraryBody = new Map((library ?? []).map((s) => [s.id, s.body as string]));
  const { data: company } = await db().from("company_setting").select("companyName").maybeSingle();
  const validUntil = new Date(Date.now() + template.validDays * 86_400_000).toISOString().slice(0, 10);
  const contact = flat(opp.contact) as { firstName: string; lastName: string } | null;
  const owner = flat(opp.owner) as { fullName: string; email: string; jobTitle: string | null; phone: string | null } | null;
  const values: Record<string, string | null> = {
    "account.name": (flat(opp.account) as { name: string } | null)?.name ?? null,
    "contact.firstName": contact?.firstName ?? "Sir/Madam",
    "contact.fullName": contact ? `${contact.firstName} ${contact.lastName}` : null,
    "opportunity.name": opp.name,
    "opportunity.amount": Number(opp.amount).toLocaleString("en-US", { maximumFractionDigits: 2 }),
    "opportunity.currency": opp.currencyCode,
    "offering.name": (flat(opp.offering) as { name: string } | null)?.name ?? null,
    "owner.name": owner?.fullName ?? null, "owner.title": owner?.jobTitle ?? null,
    "owner.email": owner?.email ?? null, "owner.phone": owner?.phone ?? null,
    "company.name": (company?.companyName as string | undefined) ?? "BabulTech",
    "today": proposalDate(today()),
    "proposal.validUntil": proposalDate(validUntil),
  };
  const sections: ProposalSection[] = template.sections.map((s) => {
    if (s.kind === "PRICING") return { kind: "PRICING", title: s.title };
    const body = s.kind === "LIBRARY" ? libraryBody.get(s.sectionId) ?? "" : s.body;
    return { kind: "TEXT", title: s.title, body: fillMergeFields(body, values) };
  });

  // The deal's live quotation, if there is one.
  const { data: quotes } = await db().from("quotation").select("id, status").eq("opportunityId", opportunityId).is("deletedAt", null).not("status", "in", "(REJECTED,EXPIRED,REVISED)").order("createdAt", { ascending: false }).limit(1);

  const { data: number, error: numErr } = await db().rpc("next_sequence_number", { p_entity_type: SEQUENCES.PROPOSAL });
  if (numErr) return { ok: false, error: numErr.message };
  const { data, error } = await db().from("proposal").insert({
    proposalNumber: number, version: 1, opportunityId, templateId: template.id || null, quotationId: quotes?.[0]?.id ?? null,
    title: `${template.name}: ${opp.name}`.slice(0, 200), sections, status: "DRAFT", validUntil, createdById: auth.user.id,
  }).select("id").single();
  if (error) return { ok: false, error: error.message };
  await event(data.id, "CREATED", auth.user.id, template.id ? `From template ${template.name}` : null);
  refreshProposal(data.id, opportunityId);
  return { ok: true, data: { id: data.id } };
}

export async function getProposal(id: string) {
  const user = await requireUser();
  if (!can(user, PERMISSIONS.OPPORTUNITY_READ)) return null;
  const { data: row } = await db().from("proposal").select("*, createdBy:app_user!proposal_createdById_fkey ( fullName )").eq("id", id).maybeSingle();
  const p = row as (ProposalRow & { createdBy: unknown }) | null;
  if (!p || !(await visibleOpportunity(p.opportunityId))) return null;
  const [{ data: opp }, { data: events }, { data: quotes }, { data: versions }] = await Promise.all([
    db().from("opportunity").select("id, name, opportunityNumber, stage, accountId, ownerUserId, account ( id, name )").eq("id", p.opportunityId).single(),
    db().from("proposal_event").select("*, actor:app_user ( fullName )").eq("proposalId", id).order("createdAt", { ascending: false }),
    db().from("quotation").select("id, quoteNumber, versionNumber, status, approvalStatus, totalAmount, currencyCode").eq("opportunityId", p.opportunityId).is("deletedAt", null).order("createdAt", { ascending: false }),
    db().from("proposal").select("id, version, status").eq("proposalNumber", p.proposalNumber).order("version"),
  ]);
  const { data: contacts } = await db().from("contact").select("id, firstName, lastName, email").eq("accountId", opp!.accountId).is("deletedAt", null).not("email", "is", null).order("firstName");
  const { data: company } = await db().from("company_setting").select("companyName").maybeSingle();
  const sections = (p.sections ?? []) as ProposalSection[];
  // A draft shows the quotation as it is now; a sent one shows what was sent.
  const live = p.status === "DRAFT" ? await pricingFor(p.quotationId) : null;
  return {
    ...p,
    sections: sections.map((s) => (s.kind === "PRICING" && p.status === "DRAFT" ? { ...s, pricing: live } : s)),
    createdBy: flat(p.createdBy) as { fullName: string } | null,
    opportunity: { ...opp!, account: flat(opp!.account) as { id: string; name: string } | null },
    events: (events ?? []).map((e) => ({ ...e, actor: flat(e.actor) as { fullName: string } | null })) as { id: string; kind: string; note: string | null; createdAt: string; actor: { fullName: string } | null }[],
    quotations: (quotes ?? []) as { id: string; quoteNumber: string; versionNumber: number; status: string; approvalStatus: string | null; totalAmount: number; currencyCode: string }[],
    versions: (versions ?? []) as { id: string; version: number; status: string }[],
    contacts: (contacts ?? []) as { id: string; firstName: string; lastName: string; email: string }[],
    companyName: (company?.companyName as string | undefined) ?? "BabulTech",
    canWrite: can(user, PERMISSIONS.OPPORTUNITY_WRITE),
  };
}

const saveSchema = z.object({
  title: z.string().trim().min(1, "Give the proposal a title.").max(200),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the valid-until date."),
  quotationId: z.string().uuid().nullable(),
  sections: z.array(z.union([
    z.object({ kind: z.literal("TEXT"), title: z.string().trim().min(1, "Every section needs a title.").max(150), body: z.string() }),
    z.object({ kind: z.literal("PRICING"), title: z.string().trim().min(1, "Every section needs a title.").max(150) }),
  ])).min(1, "A proposal needs at least one section.").max(40),
});

export async function saveProposal(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return auth;
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the proposal." };
  const { data: p } = await db().from("proposal").select("id, status, opportunityId").eq("id", id).maybeSingle();
  if (!p || !(await visibleOpportunity(p.opportunityId))) return { ok: false, error: "That proposal no longer exists." };
  if (p.status !== "DRAFT") return { ok: false, error: "This version has been sent and is frozen. Make a new version to change it." };
  const d = parsed.data;
  if (d.validUntil < today()) return { ok: false, error: "The valid-until date has already passed." };
  if (d.quotationId) {
    const { data: q } = await db().from("quotation").select("opportunityId").eq("id", d.quotationId).maybeSingle();
    if (!q || q.opportunityId !== p.opportunityId) return { ok: false, error: "That quotation is not on this deal." };
  }
  if (d.sections.some((s) => s.kind === "PRICING") && !d.quotationId) {
    return { ok: false, error: "The pricing section shows a quotation. Choose the deal's quotation, or remove the pricing section." };
  }
  const sections = d.sections.map((s) => (s.kind === "TEXT" ? { ...s, body: sanitizeRichText(s.body) ?? "" } : s));
  const { error } = await db().from("proposal").update({ title: d.title, validUntil: d.validUntil, quotationId: d.quotationId, sections, updatedAt: now() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await event(id, "EDITED", auth.user.id);
  refreshProposal(id, p.opportunityId);
  return { ok: true, data: { id } };
}

/** A sent version is frozen: changing it starts the next version as a draft. */
export async function newProposalVersion(id: string): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return auth;
  const { data: p } = await db().from("proposal").select("*").eq("id", id).maybeSingle();
  if (!p || !(await visibleOpportunity(p.opportunityId))) return { ok: false, error: "That proposal no longer exists." };
  const { data: latest } = await db().from("proposal").select("id, version, status").eq("proposalNumber", p.proposalNumber).order("version", { ascending: false }).limit(1).single();
  if (latest!.status === "DRAFT") return { ok: true, data: { id: latest!.id } };
  if (latest!.status === "ACCEPTED") return { ok: false, error: "The customer has accepted this proposal." };
  const sections = ((p.sections ?? []) as ProposalSection[]).map((s) => (s.kind === "PRICING" ? { kind: "PRICING", title: s.title } : s));
  const validDays = Math.max(7, Math.round((Date.parse(p.validUntil ?? today()) - Date.parse(String(p.createdAt).slice(0, 10))) / 86_400_000));
  const { data, error } = await db().from("proposal").insert({
    proposalNumber: p.proposalNumber, version: latest!.version + 1, opportunityId: p.opportunityId, templateId: p.templateId,
    quotationId: p.quotationId, title: p.title, sections, status: "DRAFT",
    validUntil: new Date(Date.now() + validDays * 86_400_000).toISOString().slice(0, 10), createdById: auth.user.id,
  }).select("id").single();
  if (error) return { ok: false, error: error.message };
  await event(data.id, "CREATED", auth.user.id, `Version ${latest!.version + 1}, from version ${p.version}`);
  refreshProposal(data.id, p.opportunityId);
  return { ok: true, data: { id: data.id } };
}

const sendSchema = z.object({
  contactIds: z.array(z.string().uuid()).max(20),
  extraEmails: z.array(z.string().trim().email("One of the extra addresses is not an email.")).max(10),
  message: z.string().trim().max(4000).nullable(),
});

export async function sendProposal(id: string, input: unknown): Promise<ActionResult<{ url: string; sentTo: string[] }>> {
  const auth = await authorize(PERMISSIONS.OPPORTUNITY_WRITE);
  if (!auth.ok) return auth;
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the recipients." };
  const { data: p } = await db().from("proposal").select("*").eq("id", id).maybeSingle();
  if (!p || !(await visibleOpportunity(p.opportunityId))) return { ok: false, error: "That proposal no longer exists." };
  if (p.status !== "DRAFT") return { ok: false, error: "This version was already sent. Make a new version to send changes." };
  if (!p.validUntil || p.validUntil < today()) return { ok: false, error: "The valid-until date has passed. Change it before sending." };

  const { data: opp } = await db().from("opportunity").select("accountId, stage, name").eq("id", p.opportunityId).single();
  if (["CLOSED_WON", "CLOSED_LOST"].includes(opp!.stage)) return { ok: false, error: "This deal is closed." };
  const { data: contacts } = parsed.data.contactIds.length
    ? await db().from("contact").select("email, firstName").in("id", parsed.data.contactIds).eq("accountId", opp!.accountId)
    : { data: [] as { email: string; firstName: string }[] };
  const to = [...new Set([...(contacts ?? []).map((c) => c.email).filter(Boolean), ...parsed.data.extraEmails])];
  if (!to.length) return { ok: false, error: "Choose who receives it." };
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "Email is not set up, so the proposal cannot be sent." };

  // The pricing is the quotation, sent through its own rules.
  const hasPricing = ((p.sections ?? []) as ProposalSection[]).some((s) => s.kind === "PRICING");
  if (hasPricing) {
    if (!p.quotationId) return { ok: false, error: "Choose the quotation for the pricing section first." };
    const { data: q } = await db().from("quotation").select("status, quoteNumber").eq("id", p.quotationId).maybeSingle();
    if (!q) return { ok: false, error: "The quotation no longer exists." };
    if (["DRAFT", "UNDER_REVIEW", "APPROVED"].includes(q.status)) {
      const sent = await sendQuotation(p.quotationId);
      if (!sent.ok) return { ok: false, error: `${q.quoteNumber} could not be sent with the proposal: ${sent.error}` };
    } else if (!["SENT", "ACCEPTED"].includes(q.status)) {
      return { ok: false, error: `${q.quoteNumber} is ${String(q.status).toLowerCase()}. Choose a current quotation.` };
    }
  }
  const pricing = hasPricing ? await pricingFor(p.quotationId) : null;
  const sections = ((p.sections ?? []) as ProposalSection[]).map((s) => (s.kind === "PRICING" ? { ...s, pricing } : s));

  const token = randomBytes(32).toString("base64url");
  const { error } = await db().from("proposal").update({
    status: "SENT", sections, sentAt: now(), sentTo: to.join(", "), tokenHash: hash(token), updatedAt: now(),
  }).eq("id", id).eq("status", "DRAFT");
  if (error) return { ok: false, error: error.message };
  // Older versions stop being acceptable.
  await db().from("proposal").update({ status: "SUPERSEDED", tokenHash: null, updatedAt: now() })
    .eq("proposalNumber", p.proposalNumber).lt("version", p.version).in("status", ["SENT", "VIEWED", "CHANGES_REQUESTED"]);

  const url = `${await appUrl()}/proposal/${token}`;
  const { data: settings } = await db().from("email_settings").select("*").eq("id", EMAIL_SETTINGS_ID).maybeSingle();
  const branding = brandingFromSettings(emailSettingsFromRow(settings));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const greeting = (contacts ?? []).length === 1 ? `Dear ${esc(String(contacts![0].firstName))},` : "Hello,";
  const { html, text } = renderDocumentEmail({
    branding,
    documentTitle: p.title,
    message: "",
    messageHtml: `<p>${greeting}</p><p>${parsed.data.message ? esc(parsed.data.message).replace(/\n/g, "<br>") : "Please find our proposal at the link below. You can read it online, download a PDF, and accept it or ask for changes there."}</p>`,
    summary: [
      { label: "Proposal", value: `${p.proposalNumber}${p.version > 1 ? ` (version ${p.version})` : ""}` },
      ...(pricing ? [{ label: "Total", value: `${pricing.currencyCode} ${pricing.totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` }] : []),
      { label: "Valid until", value: proposalDate(p.validUntil) },
    ],
    action: { label: "Read the proposal", url },
    senderName: auth.user.fullName,
    senderTitle: auth.user.jobTitle,
  });
  const sent = await new Resend(process.env.RESEND_API_KEY, "Proposal").emails.send({
    from: process.env.EMAIL_FROM ?? "BabulTech CRM <onboarding@resend.dev>", to,
    replyTo: auth.user.email, subject: `Proposal: ${p.title}`, html, text,
  });
  if (sent.error) {
    await event(id, "SENT", auth.user.id, `Link created; the email failed (${sent.error.message}). Share the link yourself.`);
    refreshProposal(id, p.opportunityId);
    return { ok: true, data: { url, sentTo: [] } };
  }
  await event(id, "SENT", auth.user.id, `To ${to.join(", ")}`);
  refreshProposal(id, p.opportunityId);
  revalidatePath("/quotations");
  return { ok: true, data: { url, sentTo: to } };
}

// ---------------------------------------------------------------------------
// The customer's side - reached only by the link
// ---------------------------------------------------------------------------

export async function getProposalForCustomer(token: string) {
  if (!token || token.length < 20) return null;
  const { data: p } = await db().from("proposal").select("*").eq("tokenHash", hash(token)).maybeSingle();
  if (!p) return null;
  const { data: opp } = await db().from("opportunity").select("ownerUserId, account ( name ), owner:app_user!opportunity_ownerUserId_fkey ( fullName, email, phone, jobTitle )").eq("id", p.opportunityId).single();
  const { data: company } = await db().from("company_setting").select("companyName").maybeSingle();

  if (!p.firstViewedAt) {
    await db().from("proposal").update({ firstViewedAt: now(), status: p.status === "SENT" ? "VIEWED" : p.status }).eq("id", p.id);
    await event(p.id, "VIEWED", null);
    try {
      await db().rpc("notify_user", { p_user: opp!.ownerUserId, p_kind: "ASSIGNED", p_title: `Proposal opened: ${p.title}`, p_body: `${(flat(opp!.account) as { name: string } | null)?.name ?? "The customer"} opened ${p.proposalNumber}.`, p_link: `/proposals/${p.id}`, p_entity_type: "Opportunity", p_entity_id: p.opportunityId });
    } catch { /* best effort */ }
    // No revalidatePath here: this runs while the customer page renders. The
    // internal proposal page is rendered fresh on every visit anyway.
  }
  return {
    id: p.id, proposalNumber: p.proposalNumber, version: p.version, title: p.title, status: p.firstViewedAt || p.status !== "SENT" ? p.status : "VIEWED",
    sections: (p.sections ?? []) as ProposalSection[], validUntil: p.validUntil as string | null, sentAt: p.sentAt as string,
    acceptedName: p.acceptedName as string | null, acceptedAt: p.acceptedAt as string | null, customerComment: p.customerComment as string | null,
    expired: Boolean(p.validUntil && p.validUntil < today()),
    accountName: (flat(opp!.account) as { name: string } | null)?.name ?? "",
    owner: flat(opp!.owner) as { fullName: string; email: string; phone: string | null; jobTitle: string | null } | null,
    companyName: (company?.companyName as string | undefined) ?? "BabulTech",
  };
}

const respondSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACCEPT"), name: z.string().trim().min(2, "Type your full name.").max(150), signature: z.string().startsWith("data:image/png;base64,", "Please sign in the box.").max(300000), agree: z.literal(true, { errorMap: () => ({ message: "Tick that you agree to the proposal." }) }) }),
  z.object({ action: z.literal("CHANGES"), name: z.string().trim().min(2, "Type your name.").max(150), comment: z.string().trim().min(3, "Say what you would like changed.").max(4000) }),
  z.object({ action: z.literal("DECLINE"), name: z.string().trim().min(2, "Type your name.").max(150), comment: z.string().trim().max(4000).optional() }),
]);

export async function respondToProposal(token: string, input: unknown): Promise<ActionResult<{ status: string }>> {
  const parsed = respondSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  const d = parsed.data;
  if (!token || token.length < 20) return { ok: false, error: "This link is not valid." };
  const { data: p } = await db().from("proposal").select("id, status, validUntil, opportunityId, title, proposalNumber").eq("tokenHash", hash(token)).maybeSingle();
  if (!p) return { ok: false, error: "This link is not valid any more. A newer version may have been sent to you." };
  if (!["SENT", "VIEWED", "CHANGES_REQUESTED"].includes(p.status)) return { ok: false, error: "This proposal has already been answered." };
  if (d.action === "ACCEPT" && p.validUntil && p.validUntil < today()) return { ok: false, error: "This proposal has expired. Please ask us for an updated one." };

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null;
  const status = d.action === "ACCEPT" ? "ACCEPTED" : d.action === "CHANGES" ? "CHANGES_REQUESTED" : "DECLINED";
  const patch: Record<string, unknown> = { status, updatedAt: now() };
  if (d.action === "ACCEPT") Object.assign(patch, { acceptedName: d.name, acceptedSignature: d.signature, acceptedAt: now(), acceptedIp: ip });
  else patch.customerComment = `${d.name}: ${d.comment ?? ""}`.trim();
  const { error } = await db().from("proposal").update(patch).eq("id", p.id).in("status", ["SENT", "VIEWED", "CHANGES_REQUESTED"]);
  if (error) return { ok: false, error: "That did not save. Please try again." };

  const label = d.action === "ACCEPT" ? "ACCEPTED" : d.action === "CHANGES" ? "CHANGES_REQUESTED" : "DECLINED";
  await event(p.id, label, null, d.action === "ACCEPT" ? `Signed by ${d.name}${ip ? ` from ${ip}` : ""}` : `${d.name}: ${d.comment ?? ""}`);
  const { data: opp } = await db().from("opportunity").select("ownerUserId").eq("id", p.opportunityId).single();
  const title = d.action === "ACCEPT" ? `Proposal accepted: ${p.title}` : d.action === "CHANGES" ? `Changes requested: ${p.title}` : `Proposal declined: ${p.title}`;
  const body = d.action === "ACCEPT" ? `${d.name} accepted ${p.proposalNumber}. Accept the quotation and mark the deal won.` : `${d.name}: ${d.comment ?? ""}`;
  try {
    await db().rpc("notify_user", { p_user: opp!.ownerUserId, p_kind: "APPROVAL_DECIDED", p_title: title, p_body: body.slice(0, 500), p_link: `/proposals/${p.id}`, p_entity_type: "Opportunity", p_entity_id: p.opportunityId });
  } catch { /* best effort */ }
  revalidatePath(`/proposals/${p.id}`);
  revalidatePath(`/opportunities/${p.opportunityId}`);
  return { ok: true, data: { status } };
}
