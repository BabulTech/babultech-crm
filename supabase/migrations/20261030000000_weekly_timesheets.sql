-- Weekly timesheets.
--
-- Every employee commits a number of hours a week (Hours per week on their
-- active employment contract, else 40) and submits their week, Monday to
-- Sunday, Pakistan time. A week is approved, or returned with remarks, by a
-- CRM Admin or Super Admin; a CRM Admin's week by a Super Admin only. Super
-- Admins do not submit timesheets.
--
-- weekly_timesheet: one row per person per week once they submit it.
-- timesheet_committed_hours(): the hours someone owes a week.
-- timesheet_reminders(): at 9 pm every day, a bell reminder to anyone who has
--   logged nothing today; on Sunday, a bell and email to submit the week. In
--   the morning (p_overdue), a bell and email to anyone whose last week is
--   still not submitted.

create table if not exists weekly_timesheet (
  id uuid primary key default gen_random_uuid(),
  "userId" uuid not null references app_user(id) on delete cascade,
  "weekStart" date not null check (extract(isodow from "weekStart") = 1),
  status varchar(10) not null default 'SUBMITTED' check (status in ('SUBMITTED', 'APPROVED', 'RETURNED')),
  "committedHours" numeric(5, 2) not null,
  "loggedHours" numeric(6, 2) not null,
  "shortfallReason" text,
  "submittedAt" timestamptz not null default now(),
  "decidedById" uuid references app_user(id) on delete set null,
  "decidedAt" timestamptz,
  remarks text,
  "updatedAt" timestamptz not null default now(),
  unique ("userId", "weekStart")
);
create index if not exists weekly_timesheet_week_idx on weekly_timesheet ("weekStart", status);
alter table weekly_timesheet enable row level security;
revoke all on weekly_timesheet from anon;
grant select on weekly_timesheet to authenticated;
drop policy if exists weekly_timesheet_own on weekly_timesheet;
create policy weekly_timesheet_own on weekly_timesheet for select to authenticated
  using ("userId" = (select app_current_user_id()));

-- Who someone is for timesheets: SUPER (no timesheet, approves everyone),
-- CRM_ADMIN (approves employees; approved by a Super Admin), or EMPLOYEE.
create or replace function timesheet_rank(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when r.permissions @> array['*']::text[] then 'SUPER'
    when r.permissions @> array['all:except-delete']::text[] then 'CRM_ADMIN'
    else 'EMPLOYEE' end
  from app_user u left join security_role r on r.id = u."roleId"
  where u.id = p_user;
$$;

create or replace function timesheet_committed_hours(p_user uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((
    select c."hoursPerWeek" from employment_contract c
      join staff_profile s on s.id = c."staffId"
     where s."userId" = p_user and c.status = 'ACTIVE' and c."hoursPerWeek" is not null
     order by c."startDate" desc limit 1
  ), 40);
$$;

-- The people who keep timesheets: active internal staff who are not Super Admins.
create or replace function timesheet_people()
returns table ("userId" uuid, "fullName" text, rank text, committed numeric)
language sql stable security definer set search_path = public as $$
  select u.id, u."fullName"::text, timesheet_rank(u.id), timesheet_committed_hours(u.id)
    from app_user u
   where u.status = 'ACTIVE' and u."deletedAt" is null
     and coalesce(u."userType", 'INTERNAL') = 'INTERNAL' and u."partnerId" is null
     and timesheet_rank(u.id) <> 'SUPER';
$$;
revoke all on function timesheet_rank(uuid) from public, anon;
revoke all on function timesheet_committed_hours(uuid) from public, anon;
revoke all on function timesheet_people() from public, anon, authenticated;
grant execute on function timesheet_rank(uuid), timesheet_committed_hours(uuid) to authenticated, service_role;
grant execute on function timesheet_people() to service_role;

-- Reminders. Kinds: TIMESHEET_REMINDER (bell), TIMESHEET_DUE (bell and email).
create or replace function notification_email_by_default(p_kind text)
returns boolean language sql immutable as $$
  select p_kind in ('ASSIGNED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'REPORT_READY', 'TIMESHEET_DUE');
$$;

create or replace function timesheet_reminders(p_overdue boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_week date := v_today - (extract(isodow from v_today)::int - 1);
  v_last date := v_week - 7;
  v_count integer := 0;
  p record;
  v_logged numeric;
begin
  for p in select * from timesheet_people() loop
    if p_overdue then
      if not exists (select 1 from weekly_timesheet w where w."userId" = p."userId" and w."weekStart" = v_last and w.status in ('SUBMITTED', 'APPROVED')) then
        select coalesce(sum(hours), 0) into v_logged from time_log
         where "userId" = p."userId" and "workDate" >= v_last and "workDate" < v_week;
        perform notify_user(p."userId", 'TIMESHEET_DUE', 'Last week''s timesheet is not submitted',
          format('Week of %s: %s of %s hours logged. Submit it now so it can be approved.', to_char(v_last, 'DD Mon'), round(v_logged, 1), round(p.committed, 1)),
          '/timesheets?week=' || v_last, null, null, 'timesheet-overdue-' || v_last);
        v_count := v_count + 1;
      end if;
      continue;
    end if;

    select coalesce(sum(hours), 0) into v_logged from time_log
     where "userId" = p."userId" and "workDate" >= v_week and "workDate" <= v_today;

    if extract(isodow from v_today) = 7 then
      if not exists (select 1 from weekly_timesheet w where w."userId" = p."userId" and w."weekStart" = v_week and w.status in ('SUBMITTED', 'APPROVED')) then
        perform notify_user(p."userId", 'TIMESHEET_DUE', 'Submit your timesheet for this week',
          format('You have logged %s of your %s hours this week. Submit the week today; if it is short, say why.', round(v_logged, 1), round(p.committed, 1)),
          '/timesheets?week=' || v_week, null, null, 'timesheet-due-' || v_week);
        v_count := v_count + 1;
      end if;
    elsif not exists (select 1 from time_log where "userId" = p."userId" and "workDate" = v_today) then
      perform notify_user(p."userId", 'TIMESHEET_REMINDER', 'Log today''s time',
        format('Nothing logged today yet. This week: %s of %s hours.', round(v_logged, 1), round(p.committed, 1)),
        '/timesheets', null, null, 'timesheet-day-' || v_today);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;
revoke all on function timesheet_reminders(boolean) from public, anon, authenticated;
grant execute on function timesheet_reminders(boolean) to service_role;

-- 9 pm and 9 am Pakistan time (UTC+5).
select cron.unschedule('babultech-timesheet-reminders') where exists (select 1 from cron.job where jobname = 'babultech-timesheet-reminders');
select cron.schedule('babultech-timesheet-reminders', '0 16 * * *', 'select public.timesheet_reminders(false)');
select cron.unschedule('babultech-timesheet-overdue') where exists (select 1 from cron.job where jobname = 'babultech-timesheet-overdue');
select cron.schedule('babultech-timesheet-overdue', '0 4 * * 1', 'select public.timesheet_reminders(true)');

notify pgrst, 'reload schema';
