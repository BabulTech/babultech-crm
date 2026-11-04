"use server";

import { supabaseServer } from "@/lib/supabase";
import { applySearch, applyScope, applyScopeWithPartners } from "@/lib/db";
import { PERMISSIONS, requirePermission, requireUser, scopedContext } from "@/lib/authz";
import {
  LOOKUP_PAGE_SIZE,
  type LookupEntity,
  type LookupFilters,
  type LookupRecord,
} from "@/lib/lookups";

/**
 * The search behind every reference field.
 *
 * One action for every entity rather than a search action per form: the
 * behaviour a user expects - type a few letters, get the matches you are
 * allowed to see - is the same everywhere, and thirteen copies of it would
 * drift. What differs per entity is declared in the table below.
 *
 * Two rules hold for all of them:
 *   * the caller's read permission for that entity is checked, so a lookup
 *     cannot be used to read a table the user cannot open; and
 *   * owner scoping is applied exactly as the list screens apply it, so a
 *     salesperson searching deals sees their own, not the company's.
 */

interface EntityConfig {
  table: string;
  /**
   * The read permission for that entity. People are the exception: choosing a
   * colleague as an owner, an assignee or whose expense it is happens in nearly
   * every module, and a staff list is not the sensitive thing a module
   * permission is guarding. Any internal user may search people; an external
   * login may not, which is what the null case checks.
   */
  permission: string | null;
  /** Columns matched against what was typed. */
  search: readonly string[];
  /** Columns fetched, beyond id. */
  select: string;
  /** Builds what the field shows for one row. */
  display: (row: Record<string, any>) => { label: string; sublabel?: string | null };
  /** Ordering for the unsearched list. */
  order: string;
  /** The owner column to scope by, where the entity is owned. */
  ownerField?: string;
  /**
   * The column crediting a record to a partner. Every partner's records are
   * every salesperson's, whoever owns them (20260928000008).
   */
  partnerField?: string;
  /** Rows normally hidden: retired products, closed cases, ended contracts. */
  activeFilter?: (query: any) => any;
  /** Soft-deleted rows are never offered. */
  softDeleted?: boolean;
}

const ENTITIES: Record<LookupEntity, EntityConfig> = {
  account: {
    table: "account",
    permission: PERMISSIONS.ACCOUNT_READ,
    search: ["name", "accountNumber"],
    select: "id, name, accountNumber, accountType",
    display: (r) => ({ label: r.name, sublabel: [r.accountNumber, r.accountType?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "name",
    ownerField: "ownerUserId",
    partnerField: "sourcePartnerId",
    softDeleted: true,
  },
  contact: {
    table: "contact",
    permission: PERMISSIONS.ACCOUNT_READ,
    search: ["firstName", "lastName", "email"],
    select: "id, firstName, lastName, email, jobTitle, accountId, account:account ( name )",
    display: (r) => ({
      label: `${r.firstName} ${r.lastName}`.trim(),
      sublabel: [r.account?.name ?? r.account?.[0]?.name, r.jobTitle, r.email].filter(Boolean).join(" · "),
    }),
    order: "lastName",
    activeFilter: (q) => q.eq("active", true),
    softDeleted: true,
  },
  user: {
    table: "app_user",
    permission: null,
    search: ["fullName", "email"],
    select: "id, fullName, email, jobTitle, partnerId",
    // Name only; the email appears only to tell two people of the same name apart.
    display: (r) => ({ label: r.fullName, sublabel: r.email ?? null, nameOnly: true }),
    order: "fullName",
    activeFilter: (q) => q.eq("status", "ACTIVE"),
    softDeleted: true,
  },
  partner: {
    table: "partner",
    permission: PERMISSIONS.PARTNER_READ,
    search: ["displayName", "partnerNumber"],
    select: "id, displayName, partnerNumber, partnerType",
    display: (r) => ({ label: r.displayName, sublabel: [r.partnerNumber, r.partnerType?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "displayName",
    activeFilter: (q) => q.eq("status", "ACTIVE"),
    softDeleted: true,
  },
  campaign: {
    table: "campaign",
    permission: PERMISSIONS.LEAD_READ,
    search: ["name"],
    select: "id, name, status",
    display: (r) => ({ label: r.name, sublabel: r.status?.toLowerCase() }),
    order: "name",
    activeFilter: (q) => q.in("status", ["PLANNED", "ACTIVE"]),
    softDeleted: true,
  },
  lead: {
    table: "lead",
    permission: PERMISSIONS.LEAD_READ,
    search: ["firstName", "lastName", "companyName", "leadNumber"],
    select: "id, firstName, lastName, companyName, leadNumber, status",
    display: (r) => ({
      label: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.companyName,
      sublabel: [r.leadNumber, r.companyName].filter(Boolean).join(" · "),
    }),
    order: "lastName",
    ownerField: "ownerUserId",
    partnerField: "referredByPartnerId",
    softDeleted: true,
  },
  opportunity: {
    table: "opportunity",
    permission: PERMISSIONS.OPPORTUNITY_READ,
    search: ["name", "opportunityNumber"],
    select: "id, name, opportunityNumber, stage, accountId, account:account ( name )",
    display: (r) => ({
      label: r.name,
      sublabel: [r.opportunityNumber, r.account?.name ?? r.account?.[0]?.name].filter(Boolean).join(" · "),
    }),
    order: "name",
    ownerField: "ownerUserId",
    partnerField: "sourcePartnerId",
    softDeleted: true,
  },
  quotation: {
    table: "quotation",
    permission: PERMISSIONS.OPPORTUNITY_READ,
    search: ["quoteNumber"],
    select: "id, quoteNumber, versionNumber, status, accountId",
    display: (r) => ({ label: r.quoteNumber, sublabel: [`v${r.versionNumber}`, r.status?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "quoteNumber",
    softDeleted: true,
  },
  contract: {
    table: "contract",
    permission: PERMISSIONS.OPPORTUNITY_READ,
    search: ["contractNumber", "name"],
    select: "id, contractNumber, name, status, accountId",
    display: (r) => ({ label: r.name ?? r.contractNumber, sublabel: [r.contractNumber, r.status?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "contractNumber",
    softDeleted: true,
  },
  product: {
    table: "product",
    permission: PERMISSIONS.OPPORTUNITY_READ,
    search: ["name", "productCode", "category"],
    select: "id, name, productCode, category, productType",
    display: (r) => ({ label: r.name, sublabel: [r.productCode, r.category].filter(Boolean).join(" · ") }),
    order: "name",
    activeFilter: (q) => q.eq("active", true),
    softDeleted: true,
  },
  project: {
    table: "project",
    permission: PERMISSIONS.PROJECT_READ,
    search: ["name", "projectNumber"],
    select: "id, name, projectNumber, status, accountId",
    display: (r) => ({ label: r.name, sublabel: [r.projectNumber, r.status?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "name",
    softDeleted: true,
  },
  invoice: {
    table: "invoice",
    permission: PERMISSIONS.INVOICE_READ,
    search: ["invoiceNumber"],
    select: "id, invoiceNumber, status, accountId, totalAmount, currencyCode",
    display: (r) => ({ label: r.invoiceNumber, sublabel: r.status?.toLowerCase() }),
    order: "invoiceNumber",
    softDeleted: true,
  },
  case: {
    table: "support_case",
    permission: PERMISSIONS.CASE_READ,
    search: ["caseNumber", "subject"],
    select: "id, caseNumber, subject, status, accountId",
    display: (r) => ({ label: r.subject ?? r.caseNumber, sublabel: [r.caseNumber, r.status?.toLowerCase()].filter(Boolean).join(" · ") }),
    order: "caseNumber",
    softDeleted: true,
  },
};

async function requireEntityRead(config: EntityConfig) {
  if (config.permission) {
    await requirePermission(config.permission);
    return;
  }
  const user = await requireUser();
  if (user.partnerId) {
    throw new Error("You do not have permission to do that.");
  }
}

function baseQuery(db: Awaited<ReturnType<typeof supabaseServer>>, config: EntityConfig) {
  let query: any = db.from(config.table).select(config.select);
  if (config.softDeleted) query = query.is("deletedAt", null);
  return query;
}

function applyFilters(query: any, entity: LookupEntity, config: EntityConfig, filters: LookupFilters) {
  if (filters.accountId && ["contact", "opportunity", "quotation", "contract", "project", "invoice", "case"].includes(entity)) {
    query = query.eq("accountId", filters.accountId);
  }
  if (filters.opportunityId && ["quotation", "contract", "project"].includes(entity)) {
    query = query.eq("opportunityId", filters.opportunityId);
  }
  // Partner and customer logins are not staff: they cannot own an account or
  // be assigned a task, so they stay out of people pickers.
  if (entity === "user" && filters.internalOnly !== false) query = query.is("partnerId", null);
  if (filters.accountType && entity === "account") {
    query = query.eq("accountType", filters.accountType);
  }
  if (!filters.includeInactive && config.activeFilter) query = config.activeFilter(query);
  return query;
}

/**
 * Matches for what the user typed. An empty term returns the first page, so the
 * field is useful before anyone types.
 */
export async function searchLookup(
  entity: LookupEntity,
  term: string,
  filters: LookupFilters = {},
): Promise<LookupRecord[]> {
  const config = ENTITIES[entity];
  if (!config) return [];

  // Scoped entities check the permission through scopedContext's requireUser;
  // the rest check it directly. Either way an unauthorised caller gets nothing.
  await requireEntityRead(config);
  const db = await supabaseServer();

  let query = applyFilters(baseQuery(db, config), entity, config, filters);
  query = applySearch(query, term, config.search);

  if (config.ownerField) {
    const { where } = await scopedContext(config.ownerField);
    query = config.partnerField
      ? applyScopeWithPartners(query, where, config.partnerField)
      : applyScope(query, where);
  }

  const { data, error } = await query.order(config.order).limit(LOOKUP_PAGE_SIZE);
  if (error) throw new Error(`Could not search ${entity}s: ${error.message}`);

  return nameOnly((data ?? []).map((row: Record<string, any>) => ({ id: row.id, ...config.display(row) })));
}

/**
 * The label for records already chosen, so an existing record's form opens
 * showing "Sapphire Textiles" rather than a bare id.
 *
 * Deliberately not scoped or active-filtered: a field already holding a record
 * has to be able to name it, even if that record has since been retired or
 * moved to another owner. The permission check still applies.
 */
export async function resolveLookup(entity: LookupEntity, ids: string[]): Promise<LookupRecord[]> {
  const config = ENTITIES[entity];
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!config || wanted.length === 0) return [];

  await requireEntityRead(config);
  const db = await supabaseServer();

  const { data, error } = await db.from(config.table).select(config.select).in("id", wanted);
  if (error) return [];

  return nameOnly((data ?? []).map((row: Record<string, any>) => ({ id: row.id, ...config.display(row) })));
}

/** People show by name; the email is kept only where two share a name. */
function nameOnly<T extends { label: string; sublabel?: string | null; nameOnly?: boolean }>(rows: T[]): T[] {
  const count = new Map<string, number>();
  for (const r of rows) if (r.nameOnly) count.set(r.label, (count.get(r.label) ?? 0) + 1);
  return rows.map(({ nameOnly: flag, ...r }) => (flag && (count.get(r.label) ?? 0) < 2 ? { ...r, sublabel: null } : r) as T);
}
