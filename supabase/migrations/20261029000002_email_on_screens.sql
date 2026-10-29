-- Email from any screen.
--
-- email_screen_setting: per kind of record (Prospect, Lead, Contact, Case,
-- Partner, User...), whether its page shows an Email button, which roles may
-- use it (none listed = anyone who can work on that record), and the default
-- sender and template. Administrators change it in Settings -> Email on screens.
--
-- email gains who sent it, the reply-to and BCC; email_attachment lists the
-- files sent with it, each also kept as a document on the record.

create table if not exists email_screen_setting (
  "entityType" varchar(40) primary key,
  enabled boolean not null default false,
  "roleIds" uuid[] not null default '{}',
  "defaultSenderId" uuid references email_sender(id) on delete set null,
  "defaultTemplateId" uuid references email_template(id) on delete set null,
  "updatedAt" timestamptz not null default now(),
  "updatedById" uuid references app_user(id) on delete set null
);
alter table email_screen_setting enable row level security;
revoke all on email_screen_setting from anon;
grant select on email_screen_setting to authenticated;
drop policy if exists email_screen_setting_read on email_screen_setting;
create policy email_screen_setting_read on email_screen_setting for select to authenticated using ((select app_is_internal()));

-- On for the first six, open to anyone who can work on the record.
insert into email_screen_setting ("entityType", enabled)
values ('Prospect', true), ('Lead', true), ('Contact', true), ('Case', true), ('Partner', true), ('User', true)
on conflict ("entityType") do nothing;

alter table email
  add column if not exists "sentById" uuid references app_user(id) on delete set null,
  add column if not exists "replyTo" varchar(320),
  add column if not exists "bccAddresses" text[];
create index if not exists email_related_idx on email ("relatedEntityType", "relatedEntityId", "sentReceivedAt" desc);
create index if not exists email_sender_day_idx on email ("sentById", "sentReceivedAt");

create table if not exists email_attachment (
  id uuid primary key default gen_random_uuid(),
  "emailId" uuid not null references email(id) on delete cascade,
  "documentId" uuid references document(id) on delete set null,
  "fileName" varchar(300) not null,
  "mimeType" varchar(150),
  "fileSizeBytes" integer,
  "createdAt" timestamptz not null default now()
);
create index if not exists email_attachment_email_idx on email_attachment ("emailId");
alter table email_attachment enable row level security;
revoke all on email_attachment from anon;
grant select on email_attachment to authenticated;
drop policy if exists email_attachment_read on email_attachment;
create policy email_attachment_read on email_attachment for select to authenticated
  using (exists (select 1 from email e where e.id = "emailId"));

notify pgrst, 'reload schema';
