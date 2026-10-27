import { ALL_BUT_DELETE, SUPER_ADMIN_ONLY } from "./nav-permissions";

/**
 * Every permission a role can hold, in words an administrator can act on.
 *
 * The strings are the same ones src/lib/authz.ts checks and every server action
 * demands; this file only says what each one means and groups them the way
 * somebody thinks about the business. A permission missing from here still
 * works - it just cannot be granted from Settings, which is why the list is
 * kept in step with PERMISSIONS.
 *
 * `implies` records the coarse grants that carry narrower ones, so the screen
 * can show that ticking "Everything about invoices" already covers issuing one.
 * The matching is done by can() in authz.ts; this is the explanation of it.
 */

export interface PermissionDefinition {
  value: string;
  label: string;
  /** What someone holding it can actually do, and what it exposes. */
  help: string;
  /** Narrower permissions this one already includes. */
  implies?: string[];
  /** Permissions that give away money, secrets or the system itself. */
  sensitive?: boolean;
}

export interface PermissionGroup {
  name: string;
  description: string;
  permissions: PermissionDefinition[];
}

export const PERMISSION_CATALOGUE: PermissionGroup[] = [
  {
    name: "Prospecting",
    description: "Marketing's raw prospect lists and the outreach worked on them, before anyone is a sales lead.",
    permissions: [
      { value: "prospect:read", label: "See prospects", help: "Open the prospect lists, datasets and each prospect's page." },
      { value: "prospect:write", label: "Work on prospects", help: "Import datasets, edit prospects and their people, and log outreach. Also lets them see prospects." },
      { value: "prospect:qualify", label: "Qualify prospects", help: "Turn a prospect into a sales lead, which hands it to the sales team." },
    ],
  },
  {
    name: "Sales",
    description: "Leads, customers, deals and what was agreed with them.",
    permissions: [
      { value: "lead:read", label: "See leads", help: "Open the lead list and any lead their data scope allows." },
      { value: "lead:write", label: "Work on leads", help: "Create and edit leads, and convert them." },
      { value: "account:read", label: "See customers", help: "Open accounts and contacts." },
      { value: "account:write", label: "Edit customers", help: "Create and change accounts and contacts, and give a contact portal access." },
      { value: "opportunity:read", label: "See deals", help: "Open the pipeline and deal pages." },
      { value: "opportunity:write", label: "Work on deals", help: "Create and edit deals, move stages, and price them." },
      { value: "quotation:approve", label: "Approve quotations", help: "Approve a quote so it can be sent to the customer." },
      { value: "contract:write", label: "Work on contracts", help: "Create and edit contracts and their renewal terms." },
    ],
  },
  {
    name: "Partners and commission",
    description: "The partner network, what they earn and when it is paid.",
    permissions: [
      { value: "partner:read", label: "See partners", help: "Open the partner list and partner pages." },
      { value: "partner:write", label: "Manage partners", help: "Create and edit partners, and give their people portal access." },
      { value: "commission:read", label: "See commission", help: "See what each partner is owed and paid, deal by deal." },
      { value: "commission:approve", label: "Decide commission", help: "Answer partners' rate requests, change a rate, set the payment date, and mark commission paid or rejected.", sensitive: true },
    ],
  },
  {
    name: "Delivery",
    description: "Projects, the work in them, support cases and time.",
    permissions: [
      { value: "project:read", label: "See projects", help: "Open projects, their tasks and their plans." },
      { value: "project:write", label: "Update their own work", help: "Change task progress and log time on projects they are on." },
      { value: "project:manage", label: "Run projects", help: "Create projects, add people, create and assign tasks, and delete projects." },
      { value: "project:rates", label: "See rates and margin", help: "Billing and cost rates, and the margin figures derived from them.", sensitive: true },
      { value: "time:approve", label: "Approve time", help: "Approve or reject submitted timesheets, which is what makes time billable." },
      { value: "content:review", label: "Review content", help: "Review and approve content items on content projects." },
      { value: "case:read", label: "See support cases", help: "Open the case list and case pages." },
      { value: "case:write", label: "Work on cases", help: "Create cases, reply to customers and close them." },
    ],
  },
  {
    name: "Money",
    description: "Invoicing, payments, supplier bills and expense claims.",
    permissions: [
      { value: "invoice:read", label: "See invoices", help: "Read invoices, payments and the receivables ledger." },
      { value: "invoice:write", label: "Draft invoices", help: "Create and edit draft invoices." },
      {
        value: "invoice:approve",
        label: "Everything about invoices",
        help: "Approve, issue and void invoices. The coarse grant: it already includes the two below.",
        implies: ["invoice:issue", "invoice:void"],
        sensitive: true,
      },
      { value: "invoice:issue", label: "Issue invoices", help: "Send an approved invoice to the customer.", sensitive: true },
      { value: "invoice:void", label: "Void invoices", help: "Cancel or write off an invoice.", sensitive: true },
      { value: "payment:write", label: "Record payments", help: "Record money received and allocate it to invoices.", sensitive: true },
      { value: "payable:approve", label: "Approve supplier bills", help: "Approve vendor bills for payment.", sensitive: true },
      { value: "period:close", label: "Close periods", help: "Lock an accounting period so its figures stop moving.", sensitive: true },
      { value: "expense:read", label: "See expenses", help: "Read expense claims their data scope allows." },
      { value: "expense:write", label: "File expenses", help: "Create and edit their own expense claims." },
      { value: "expense:approve", label: "Approve expenses", help: "Approve or reject other people's claims, and settle them.", sensitive: true },
    ],
  },
  {
    name: "HR",
    description: "People, hiring, employment contracts and pay. Confidential: grant it to whoever handles HR.",
    permissions: [
      { value: "people:read", label: "See employee contracts and pay", help: "Open People: every hire's profile, documents, contracts and what they are paid.", sensitive: true },
      { value: "people:write", label: "Hire and manage contracts", help: "Onboard new hires, prepare and send contracts, sign for the company, renew, convert, terminate and record resignations. Hears when a contract is about to end.", sensitive: true },
    ],
  },
  {
    name: "Security",
    description: "The credential vault and the system itself. Grant sparingly.",
    permissions: [
      { value: "secret:read", label: "Read stored credentials", help: "List and reveal the passwords and keys in the vault.", sensitive: true },
      { value: "secret:write", label: "Manage stored credentials", help: "Add, change and revoke vault entries.", sensitive: true },
      {
        value: "user:view_as",
        label: "View as another user",
        help: "Open the CRM or a portal as someone else sees it, read-only, for up to 30 minutes. Needs a reason, is logged, and never works on an administrator.",
        sensitive: true,
      },
      {
        value: "record:delete",
        label: "Delete records",
        help: "Delete any record of any kind, whatever its status or stage, to the recycle bin; restore and erase. For the Super Admin only.",
        sensitive: true,
      },
      {
        value: "role:manage",
        label: "Manage roles and administrators",
        help: "Create and change roles, and give anyone the Super Admin or CRM Admin role. For the Super Admin only.",
        sensitive: true,
      },
      {
        value: "admin:*",
        label: "Administer the system",
        help: "Users, roles, settings and every reference list. Holding this is close to holding everything.",
        sensitive: true,
      },
    ],
  },
];

export const ALL_PERMISSIONS = PERMISSION_CATALOGUE.flatMap((g) => g.permissions.map((p) => p.value));

export const DATA_SCOPES = [
  { value: "OWN", label: "Own records", help: "Only what they own or are assigned to." },
  { value: "TEAM", label: "Their team", help: "Their own records plus their team's." },
  { value: "DEPARTMENT", label: "Their reporting line", help: "Their own records plus everyone who reports to them, however deep." },
  { value: "ALL", label: "Everything", help: "Every record in the system." },
] as const;

export type DataScopeValue = (typeof DATA_SCOPES)[number]["value"];

/** Everything a permission list covers once coarse grants are expanded. */
export function effectivePermissions(permissions: string[]): Set<string> {
  const held = new Set(permissions);
  if (held.has("*")) return new Set(["*", ...ALL_PERMISSIONS]);
  if (held.has(ALL_BUT_DELETE)) return new Set([ALL_BUT_DELETE, ...ALL_PERMISSIONS.filter((p) => !SUPER_ADMIN_ONLY.includes(p))]);

  for (const group of PERMISSION_CATALOGUE) {
    for (const permission of group.permissions) {
      if (!permission.implies) continue;
      if (held.has(permission.value)) permission.implies.forEach((value) => held.add(value));
    }
  }

  // An entity-wide grant such as project:* covers each of that entity's
  // permissions, which is how can() reads it.
  for (const value of [...held]) {
    const [entity, action] = value.split(":");
    if (action !== "*" || entity === "admin") continue;
    for (const candidate of ALL_PERMISSIONS) {
      if (candidate.startsWith(`${entity}:`)) held.add(candidate);
    }
  }

  return held;
}
