-- Repair: the first version of 20261021000001 meant to create a new table
-- called email_template, found the marketing templates table of that name
-- already there, and revoked its grants - leaving the Email templates screen
-- unable to read it. The grants are put back as every other table has them
-- (row-level security still decides who sees what), and the system emails
-- get their own table.

grant all on email_template to anon, authenticated;

create table if not exists system_email_template (
  key text primary key,
  subject text not null,
  body text not null,
  "updatedAt" timestamptz not null default now(),
  "updatedById" uuid references app_user(id) on delete set null
);

alter table system_email_template enable row level security;
revoke all on system_email_template from anon, authenticated;

notify pgrst, 'reload schema';
