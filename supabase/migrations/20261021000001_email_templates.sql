-- Editable system emails: welcome and password links, contract signing,
-- portal access.
--
-- A row holds an administrator's version of one email's subject and message.
-- No row means the wording built into the app is used, so "Reset to default"
-- is simply deleting the row. The button, the details box, the logo and the
-- footer are not stored here: they stay in the layout, so an edit cannot
-- break the link the email exists to deliver.
--
-- Not to be confused with email_template, the marketing templates.
-- Read and written by the server with the service role only.

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
