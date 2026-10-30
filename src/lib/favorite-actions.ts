/** The actions a person can keep as favourites, offered by what their role may do. */
export const FAVORITE_ACTIONS: { href: string; label: string; permission?: string }[] = [
  { href: "/timesheets?log=1", label: "Log time" },
  { href: "/leads/new", label: "New lead", permission: "lead:write" },
  { href: "/leads/import", label: "Import leads", permission: "lead:write" },
  { href: "/prospects/import", label: "Import prospects", permission: "prospect:write" },
  { href: "/campaigns/new", label: "New campaign", permission: "lead:write" },
  { href: "/accounts/new", label: "New account", permission: "account:write" },
  { href: "/contacts/new", label: "New contact", permission: "account:write" },
  { href: "/opportunities/new", label: "New deal", permission: "opportunity:write" },
  { href: "/cases/new", label: "New case", permission: "case:write" },
  { href: "/projects/new", label: "New project", permission: "project:write" },
  { href: "/invoices/new", label: "New invoice", permission: "invoice:write" },
  { href: "/expenses/new", label: "New expense", permission: "expense:write" },
];
