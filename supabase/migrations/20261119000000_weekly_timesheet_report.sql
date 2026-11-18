-- The Monday timesheet report to every employee.
--
-- At 09:00 Pakistan time every Monday this queues one 'weekly_timesheet_report'
-- job; the app's job runner emails last week's committed hours, logged hours
-- and approver notes for everyone (src/lib/weekly-timesheet-report.ts).
-- A week already queued is not queued again.

create or replace function timesheet_weekly_report_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week text := to_char((now() at time zone 'Asia/Karachi')::date, 'IYYY-IW');
begin
  if exists (select 1 from job where "jobType" = 'weekly_timesheet_report' and payload->>'week' = v_week) then
    return;
  end if;
  insert into job ("jobType", title, payload)
  values ('weekly_timesheet_report', 'Weekly timesheet report, week ' || v_week, jsonb_build_object('week', v_week));
end;
$$;
revoke all on function timesheet_weekly_report_tick() from public, anon, authenticated;

select cron.unschedule('babultech-weekly-timesheet-report') where exists (select 1 from cron.job where jobname = 'babultech-weekly-timesheet-report');
select cron.schedule('babultech-weekly-timesheet-report', '0 4 * * 1', 'select public.timesheet_weekly_report_tick()');
