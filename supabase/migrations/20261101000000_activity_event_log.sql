-- The audit trail: one append-only stream of what happened in the portal.
--
-- activity_event is written by database triggers (records, changes, sign-ins,
-- timesheets, jobs, reminders) and by src/lib/mail.ts (every email). It holds no
-- link to app_user on purpose: an entry must outlive the person it names, so the
-- name is copied in. Nobody can edit or delete a row, whatever their role.

create table if not exists activity_event (
  id uuid primary key default gen_random_uuid(),
  "occurredAt" timestamptz not null default now(),
  category varchar(20) not null check (category in ('EMAIL', 'RECORD', 'CHANGE', 'SIGN_IN', 'TIMESHEET', 'REMINDER', 'SYSTEM')),
  action varchar(40) not null,
  outcome varchar(12) not null default 'OK' check (outcome in ('OK', 'FAILED', 'SKIPPED')),
  summary text not null,
  "actorId" uuid,
  "actorName" text,
  "entityType" varchar(60),
  "entityId" uuid,
  detail jsonb,
  "sourceKey" text unique
);
create index if not exists activity_event_time_idx on activity_event ("occurredAt" desc);
create index if not exists activity_event_filter_idx on activity_event (category, outcome, "occurredAt" desc);
create index if not exists activity_event_actor_idx on activity_event ("actorId", "occurredAt" desc);
create index if not exists activity_event_entity_idx on activity_event ("entityType", "entityId");

alter table activity_event enable row level security;
drop policy if exists activity_event_read on activity_event;
create policy activity_event_read on activity_event for select
  using (app_is_internal() and (app_has_permission('admin:*') or "actorId" = app_current_user_id()));
revoke insert, update, delete, truncate on activity_event from public, anon, authenticated;
grant select on activity_event to authenticated;
grant select, insert on activity_event to service_role;

create or replace function activity_event_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'The activity log cannot be changed.';
end $$;
drop trigger if exists activity_event_locked on activity_event;
create trigger activity_event_locked before update or delete on activity_event
  for each row execute function activity_event_append_only();

-- Logging must never stop the work it records, so a failure here is swallowed.
create or replace function log_activity(
  p_category text, p_action text, p_summary text,
  p_entity_type text default null, p_entity_id uuid default null,
  p_actor uuid default null, p_outcome text default 'OK', p_detail jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := p_actor;
begin
  if v_actor is null then
    begin v_actor := app_current_user_id(); exception when others then v_actor := null; end;
  end if;
  insert into activity_event (category, action, outcome, summary, "actorId", "actorName", "entityType", "entityId", detail)
  values (p_category, p_action, p_outcome, left(p_summary, 500), v_actor,
          (select "fullName" from app_user where id = v_actor), p_entity_type, p_entity_id, p_detail);
exception when others then
  raise warning 'activity log: %', sqlerrm;
end $$;
revoke all on function log_activity(text, text, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function activity_label(p_row jsonb)
returns text language sql immutable as $$
  select coalesce(p_row->>'name', p_row->>'subject', p_row->>'title', p_row->>'fullName',
    p_row->>'invoiceNumber', p_row->>'quotationNumber', p_row->>'contractNumber', p_row->>'caseNumber',
    p_row->>'billNumber', p_row->>'paymentNumber', p_row->>'expenseNumber', p_row->>'companyName',
    nullif(btrim(coalesce(p_row->>'firstName', '') || ' ' || coalesce(p_row->>'lastName', '')), ''),
    p_row->>'email', p_row->>'id');
$$;

-- Created, deleted, restored. TG_ARGV[0] is the label people know the record by.
create or replace function activity_record_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type text := tg_argv[0];
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_action text;
begin
  if tg_op = 'INSERT' then v_action := 'CREATED';
  elsif tg_op = 'DELETE' then v_action := 'DELETED_PERMANENTLY';
  elsif v_old->>'deletedAt' is null and v_new->>'deletedAt' is not null then v_action := 'DELETED';
  elsif v_old->>'deletedAt' is not null and v_new->>'deletedAt' is null then v_action := 'RESTORED';
  else return null;
  end if;
  perform log_activity('RECORD', v_action,
    format('%s %s: %s', v_type, replace(lower(v_action), '_', ' '), activity_label(v_row)),
    v_type, (v_row->>'id')::uuid);
  return null;
exception when others then
  raise warning 'activity log: %', sqlerrm;
  return null;
end $$;

do $$
declare
  t record;
  v_has_deleted boolean;
begin
  for t in select * from (values
    ('lead', 'Lead'), ('account', 'Account'), ('contact', 'Contact'), ('opportunity', 'Opportunity'),
    ('quotation', 'Quotation'), ('contract', 'Contract'), ('project', 'Project'), ('project_task', 'ProjectTask'),
    ('invoice', 'Invoice'), ('payment', 'Payment'), ('expense', 'Expense'), ('support_case', 'SupportCase'),
    ('partner', 'Partner'), ('app_user', 'User'), ('prospect', 'Prospect'), ('time_log', 'TimeLog'),
    ('vendor_bill', 'VendorBill'), ('activity', 'Activity'), ('employment_contract', 'EmploymentContract'),
    ('product', 'Product'), ('campaign', 'Campaign')
  ) as x(tbl, label) loop
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t.tbl and column_name = 'deletedAt') into v_has_deleted;
    execute format('drop trigger if exists activity_record on %I', t.tbl);
    execute format('create trigger activity_record after insert or delete %s on %I for each row execute function activity_record_trigger(%L)',
      case when v_has_deleted then 'or update of "deletedAt"' else '' end, t.tbl, t.label);
  end loop;
end $$;

-- Every field change, which is also how submissions and approvals are captured.
create or replace function activity_change_text(r audit_history)
returns text language sql immutable as $$
  select format('%s: %s changed from %s to %s', r."entityType", r."fieldName", coalesce(left(r."oldValue", 120), 'empty'), coalesce(left(r."newValue", 120), 'empty'));
$$;

create or replace function activity_from_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform log_activity('CHANGE', 'FIELD_CHANGED', activity_change_text(new), new."entityType", new."entityId", new."changedById",
    'OK', jsonb_build_object('field', new."fieldName", 'from', new."oldValue", 'to', new."newValue", 'source', new.source));
  return null;
end $$;
drop trigger if exists activity_from_audit on audit_history;
create trigger activity_from_audit after insert on audit_history for each row execute function activity_from_audit();

create or replace function activity_from_login()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform log_activity('SIGN_IN', left(new."eventType", 40), format('%s: %s', replace(lower(new."eventType"), '_', ' '), coalesce(new.email, 'unknown')),
    null, null, new."userId", case when new."eventType" ilike '%FAILED%' then 'FAILED' else 'OK' end,
    jsonb_build_object('ip', new.ip, 'reason', new.reason, 'detail', new.detail));
  return null;
end $$;
drop trigger if exists activity_from_login on login_event;
create trigger activity_from_login after insert on login_event for each row execute function activity_from_login();

create or replace function activity_from_timesheet()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text := (select "fullName" from app_user where id = new."userId");
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return null; end if;
  perform log_activity('TIMESHEET', 'WEEK_' || left(new.status, 20), format('%s, week of %s: %s', v_name, to_char(new."weekStart", 'DD Mon YYYY'), lower(new.status)), 'User', new."userId");
  return null;
end $$;
drop trigger if exists activity_from_timesheet on weekly_timesheet;
create trigger activity_from_timesheet after insert or update on weekly_timesheet for each row execute function activity_from_timesheet();

create or replace function activity_from_job()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is not distinct from old.status or new.status not in ('DONE', 'FAILED', 'CANCELLED') then return null; end if;
  perform log_activity('SYSTEM', 'JOB_' || new.status, format('Background job %s: %s', lower(new.status), new.title), null, null, new."createdById",
    case when new.status = 'FAILED' then 'FAILED' when new.status = 'CANCELLED' then 'SKIPPED' else 'OK' end,
    jsonb_build_object('type', new."jobType"));
  return null;
end $$;
drop trigger if exists activity_from_job on job;
create trigger activity_from_job after update of status on job for each row execute function activity_from_job();

create or replace function activity_from_reminder()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind not in ('TIMESHEET_REMINDER', 'TIMESHEET_DUE') then return null; end if;
  perform log_activity('REMINDER', new.kind, format('%s to %s', new.title, (select "fullName" from app_user where id = new."userId")), 'User', new."userId");
  return null;
end $$;
drop trigger if exists activity_from_reminder on notification;
create trigger activity_from_reminder after insert on notification for each row execute function activity_from_reminder();

-- The record card history stays complete too: types the feed could not name.
create or replace function app_can_read_audit(p_entity_type text)
returns boolean language sql stable as $$
  select case p_entity_type
    when 'Lead'        then app_has_permission('lead:read')
    when 'Campaign'    then app_has_permission('lead:read')
    when 'Account'     then app_has_permission('account:read')
    when 'Contact'     then app_has_permission('account:read')
    when 'Opportunity' then app_has_permission('opportunity:read')
    when 'Quotation'   then app_has_permission('quotation:read')
    when 'Contract'    then app_has_permission('contract:read')
    when 'Product'     then app_has_permission('opportunity:read')
    when 'Partner'     then app_has_permission('partner:read')
    when 'Commission'  then app_has_permission('commission:read')
    when 'PartnerCommission' then app_has_permission('commission:read')
    when 'Case'        then app_has_permission('case:read')
    when 'SupportCase' then app_has_permission('case:read')
    when 'Project'     then app_has_permission('project:read')
    when 'Task'        then app_has_permission('project:read')
    when 'ProjectTask' then app_has_permission('project:read')
    when 'Timesheet'   then app_has_permission('project:read')
    when 'TimeLog'     then app_has_permission('project:read')
    when 'Activity'    then app_has_permission('lead:read')
    when 'Invoice'     then app_has_permission('invoice:read')
    when 'Payment'     then app_has_permission('invoice:read')
    when 'VendorBill'  then app_has_permission('invoice:read')
    when 'Expense'     then app_has_permission('expense:read')
    when 'User'        then app_has_permission('admin:*')
    when 'StaffProfile' then app_has_permission('admin:*')
    when 'EmploymentContract' then app_has_permission('admin:*')
    else false
  end;
$$;

-- History. sourceKey keeps these from ever being added twice.
insert into activity_event ("occurredAt", category, action, summary, "actorId", "actorName", "entityType", "entityId", detail, "sourceKey")
select a."changedAt" at time zone 'UTC', 'CHANGE', 'FIELD_CHANGED', left(activity_change_text(a), 500), a."changedById", u."fullName", a."entityType", a."entityId",
  jsonb_build_object('field', a."fieldName", 'from', a."oldValue", 'to', a."newValue", 'source', a.source), 'audit:' || a.id
from audit_history a left join app_user u on u.id = a."changedById"
on conflict ("sourceKey") do nothing;

insert into activity_event ("occurredAt", category, action, outcome, summary, "actorId", "actorName", detail, "sourceKey")
select l."createdAt", 'SIGN_IN', left(l."eventType", 40), case when l."eventType" ilike '%FAILED%' then 'FAILED' else 'OK' end,
  format('%s: %s', replace(lower(l."eventType"), '_', ' '), coalesce(l.email, 'unknown')), l."userId", u."fullName",
  jsonb_build_object('ip', l.ip, 'reason', l.reason, 'detail', l.detail), 'login:' || l.id
from login_event l left join app_user u on u.id = l."userId"
on conflict ("sourceKey") do nothing;

insert into activity_event ("occurredAt", category, action, outcome, summary, "actorName", "entityType", "entityId", detail, "sourceKey")
select coalesce(n."emailedAt", n."createdAt"), 'EMAIL', 'NOTIFICATION',
  case n."emailStatus" when 'SENT' then 'OK' when 'FAILED' then 'FAILED' else 'SKIPPED' end,
  format('Email to %s: %s', coalesce(u."fullName", 'a former user'), left(n.title, 300)), 'BabulTech CRM', n."entityType", n."entityId",
  jsonb_build_object('source', 'Notification', 'to', coalesce(u."notificationEmail", u.email), 'error', n."emailError", 'backfilled', true), 'notif:' || n.id
from notification n left join app_user u on u.id = n."userId"
where n."emailStatus" in ('SENT', 'FAILED', 'SKIPPED')
on conflict ("sourceKey") do nothing;

insert into activity_event ("occurredAt", category, action, outcome, summary, "actorId", "actorName", "entityType", "entityId", detail, "sourceKey")
select coalesce(e."sentReceivedAt", e."createdAt"), 'EMAIL', 'RECORD_EMAIL', case e.status when 'SENT' then 'OK' when 'FAILED' then 'FAILED' else 'SKIPPED' end,
  format('Email to %s: %s', array_to_string(array[e."toAddresses"::text], ', '), left(e.subject, 300)), e."sentById", u."fullName", e."relatedEntityType", e."relatedEntityId",
  jsonb_build_object('source', 'Record email', 'backfilled', true), 'email:' || e.id
from email e left join app_user u on u.id = e."sentById"
where e.direction = 'OUTBOUND'
on conflict ("sourceKey") do nothing;

-- Failed notification emails are tried again for a week. A timesheet reminder
-- for a week since submitted is no longer true, so it is dropped instead.
create or replace function retry_failed_notification_emails()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  update notification n set "emailStatus" = 'SKIPPED', "emailError" = 'No longer needed: the timesheet was submitted.'
   where n."emailStatus" = 'FAILED' and n.kind = 'TIMESHEET_DUE'
     and exists (select 1 from weekly_timesheet w where w."userId" = n."userId" and w.status in ('SUBMITTED', 'APPROVED')
                  and n.link = '/timesheets?week=' || w."weekStart");
  update notification set "emailStatus" = 'PENDING'
   where "emailStatus" = 'FAILED' and "createdAt" > now() - interval '7 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function retry_failed_notification_emails() from public, anon, authenticated;
grant execute on function retry_failed_notification_emails() to service_role;

select cron.unschedule('babultech-email-retry') where exists (select 1 from cron.job where jobname = 'babultech-email-retry');
select cron.schedule('babultech-email-retry', '20 */3 * * *', 'select public.retry_failed_notification_emails()');

notify pgrst, 'reload schema';
