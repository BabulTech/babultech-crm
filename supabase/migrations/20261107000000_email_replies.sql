-- Replies to emails sent from the CRM come back in: Resend receives mail for
-- babultech.com and tells /api/webhooks/resend, which files each reply on the
-- record its email went from (src/lib/email-replies.ts).

-- Secrets the server needs that should not depend on the hosting platform's
-- settings: here, the webhook's signing secret. Service role only.
create table if not exists app_secret (
  name varchar(100) primary key,
  value text not null,
  "updatedAt" timestamptz not null default now()
);
alter table app_secret enable row level security;
revoke all on app_secret from public, anon, authenticated;
grant select, insert, update on app_secret to service_role;

-- A reply is worth an email to whoever sent the original.
create or replace function notification_email_by_default(p_kind text)
returns boolean language sql immutable as $$
  select p_kind in ('ASSIGNED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'REPORT_READY', 'TIMESHEET_DUE', 'EMAIL_REPLY');
$$;

create index if not exists email_inbound_idx on email ("sentReceivedAt" desc) where direction = 'INBOUND';

notify pgrst, 'reload schema';
