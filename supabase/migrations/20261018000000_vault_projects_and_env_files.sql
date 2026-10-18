-- The vault, by project, and whole .env files as one entry.
--
-- Every secret now belongs to a project, or to none - which the screens call
-- "BabulTech Internal", for company-wide credentials. A null rather than a
-- placeholder project, so no dummy project appears in project lists, reports
-- or time logging.
--
-- ENV_FILE holds a whole .env file as one encrypted value. Its variable names
-- (never the values) are kept in "envKeys", so a search for RESEND_API_KEY
-- finds every project that uses it.

alter type "SecretKind" add value if not exists 'ENV_FILE';

alter table secret
  add column if not exists "projectId" uuid references project(id) on delete set null,
  add column if not exists "envKeys" text[];

create index if not exists secret_project_idx on secret ("projectId");
