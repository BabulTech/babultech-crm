-- The Monday summary email to the Super Admin and CRM Admins.
--
-- At 08:00 Pakistan time every Monday this queues one 'weekly_summary' job;
-- the app's job runner (called by jobs_tick every minute) builds last week's
-- Company overview and emails it (src/lib/weekly-summary.ts). A week already
-- queued is not queued again.

create or replace function company_weekly_summary_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week text := to_char((now() at time zone 'Asia/Karachi')::date, 'IYYY-IW');
begin
  if exists (select 1 from job where "jobType" = 'weekly_summary' and payload->>'week' = v_week) then
    return;
  end if;
  insert into job ("jobType", title, payload)
  values ('weekly_summary', 'Weekly summary email, week ' || v_week, jsonb_build_object('week', v_week));
end;
$$;
revoke all on function company_weekly_summary_tick() from public, anon, authenticated;

select cron.unschedule('babultech-weekly-summary') where exists (select 1 from cron.job where jobname = 'babultech-weekly-summary');
select cron.schedule('babultech-weekly-summary', '0 3 * * 1', 'select public.company_weekly_summary_tick()');
