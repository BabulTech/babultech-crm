-- Prospecting, phase 4: outreach analytics and daily reminders, from ORMS.
--
-- prospect_outreach_analytics() counts what was logged in a date range -
-- emails, follow-ups, replies, calls, voicemails, meetings - by day, person,
-- hour, weekday and campaign, and the funnel from prospect to qualified lead.
-- It runs as the caller, so row-level security limits it to the campaigns
-- they may see. Days and hours are Pakistan time, as everywhere else.
--
-- prospect_reminders() runs daily: one summary per person of the outreach
-- follow-ups due today and overdue, and one per campaign owner of prospects
-- left with no next step (worked, but no open task).

create or replace function prospect_outreach_analytics(
  p_from date, p_to date, p_campaign uuid default null, p_user uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with a as (
    select x.*, (x."occurredAt" at time zone 'Asia/Karachi') as local
    from prospect_activity x
    where (x."occurredAt" at time zone 'Asia/Karachi')::date between p_from and p_to
      and (p_campaign is null or x."campaignId" = p_campaign)
      and (p_user is null or x."actorId" = p_user)
  ),
  totals as (
    select
      count(*) filter (where type = 'EMAIL_SENT') emails,
      count(*) filter (where type = 'FOLLOWUP_SENT') followups,
      count(*) filter (where type = 'EMAIL_REPLY') replies,
      count(*) filter (where type = 'CALL_ATTEMPTED') "callsNoAnswer",
      count(*) filter (where type = 'CALL_CONNECTED') "callsConnected",
      count(*) filter (where type = 'VOICEMAIL') voicemails,
      count(*) filter (where type in ('MEETING_BOOKED')) meetings,
      count(distinct "prospectId") filter (where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')) "prospectsTouched"
    from a
  ),
  daily as (
    select local::date as day,
      count(*) filter (where type in ('EMAIL_SENT', 'FOLLOWUP_SENT')) sends,
      count(*) filter (where type = 'EMAIL_REPLY') replies,
      count(*) filter (where type in ('CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')) calls,
      count(*) filter (where type = 'CALL_CONNECTED') connected,
      count(*) filter (where type = 'MEETING_BOOKED') meetings,
      to_char(min(local) filter (where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')), 'HH12:MI AM') "firstAt",
      to_char(max(local) filter (where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')), 'HH12:MI AM') "lastAt"
    from a group by 1
  ),
  people as (
    select a."actorId" id, coalesce(u."fullName", 'Someone') name,
      count(*) filter (where type in ('EMAIL_SENT', 'FOLLOWUP_SENT')) sends,
      count(*) filter (where type in ('CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')) calls,
      count(*) filter (where type = 'CALL_CONNECTED') connected,
      count(*) filter (where type = 'EMAIL_REPLY') replies,
      count(*) filter (where type = 'MEETING_BOOKED') meetings
    from a left join app_user u on u.id = a."actorId"
    where type <> 'STATUS_CHANGED' and type <> 'NOTE_ADDED'
    group by 1, 2
  ),
  hours as (
    select extract(hour from local)::int as hour, count(*) n,
      count(*) filter (where type in ('CALL_CONNECTED', 'EMAIL_REPLY', 'MEETING_BOOKED')) good
    from a where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL', 'EMAIL_REPLY', 'MEETING_BOOKED')
    group by 1
  ),
  weekdays as (
    select extract(isodow from local)::int as dow,
      count(*) filter (where type in ('CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL')) calls,
      count(*) filter (where type = 'CALL_CONNECTED') connected,
      count(*) filter (where type = 'EMAIL_REPLY') replies
    from a group by 1
  ),
  entries as (
    select e.* from prospect_campaign_entry e
    where (p_campaign is null or e."campaignId" = p_campaign)
  ),
  campaigns as (
    select c.id, c.name,
      count(e.id) total,
      count(e.id) filter (where e.status <> 'new') worked,
      count(e.id) filter (where e.status in ('replied', 'interested_meeting', 'won')) replied,
      count(e.id) filter (where e.status in ('interested_meeting', 'won')) meetings,
      count(e.id) filter (where e.status = 'won') won
    from prospect_campaign c left join prospect_campaign_entry e on e."campaignId" = c.id
    where c."deletedAt" is null and (p_campaign is null or c.id = p_campaign)
    group by 1, 2
  )
  select jsonb_build_object(
    'totals', (select to_jsonb(totals) from totals),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily) order by day desc) from daily), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(to_jsonb(people) order by sends + calls desc) from people), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(to_jsonb(hours) order by hour) from hours), '[]'::jsonb),
    'weekdays', coalesce((select jsonb_agg(to_jsonb(weekdays) order by dow) from weekdays), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(to_jsonb(campaigns) order by total desc) from campaigns), '[]'::jsonb),
    'funnel', jsonb_build_object(
      'inCampaigns', (select count(distinct "prospectId") from entries),
      'worked', (select count(distinct "prospectId") from entries where status <> 'new'),
      'replied', (select count(distinct "prospectId") from entries where status in ('replied', 'interested_meeting', 'won')),
      'meetings', (select count(distinct "prospectId") from entries where status in ('interested_meeting', 'won')),
      'qualified', (select count(*) from prospect p
                    where p.status = 'QUALIFIED' and (p."qualifiedAt" at time zone 'Asia/Karachi')::date between p_from and p_to
                      and (p_user is null or p."qualifiedById" = p_user)
                      and (p_campaign is null or exists (select 1 from prospect_campaign_entry e where e."prospectId" = p.id and e."campaignId" = p_campaign)))
    )
  );
$$;
revoke all on function prospect_outreach_analytics(date, date, uuid, uuid) from public, anon;
grant execute on function prospect_outreach_analytics(date, date, uuid, uuid) to authenticated;

create or replace function prospect_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_row record;
  v_count integer := 0;
begin
  -- Each person's outreach follow-ups: one summary, not one per task.
  for v_row in
    select "assignedTo" as user_id,
           count(*) filter (where "dueDate" = v_today) as due,
           count(*) filter (where "dueDate" < v_today) as overdue
      from prospect_task
     where status = 'open' and "assignedTo" is not null and "dueDate" <= v_today
     group by 1
  loop
    perform notify_user(
      v_row.user_id, 'TASK_DUE',
      case when v_row.overdue > 0
           then v_row.due || ' outreach follow-up' || case when v_row.due = 1 then '' else 's' end || ' due today, ' || v_row.overdue || ' overdue'
           else v_row.due || ' outreach follow-up' || case when v_row.due = 1 then '' else 's' end || ' due today' end,
      'Calls and emails to come back to from prospect outreach.',
      '/prospects/tasks' || case when v_row.overdue > 0 then '?tab=overdue' else '' end,
      null, null, 'prospect-tasks:' || v_row.user_id || ':' || v_today);
    v_count := v_count + 1;
  end loop;

  -- Worked prospects with nothing planned next, per campaign, to its owner.
  for v_row in
    select c.id, c.name, c."ownerUserId" as user_id, count(*) as n
      from prospect_campaign_entry e
      join prospect_campaign c on c.id = e."campaignId"
     where c."deletedAt" is null and c.status = 'ACTIVE' and c."ownerUserId" is not null
       and e.status in ('contacted', 'following_up', 'replied', 'interested_meeting')
       and not exists (select 1 from prospect_task t where t."prospectId" = e."prospectId" and t.status = 'open')
     group by 1, 2, 3
  loop
    perform notify_user(
      v_row.user_id, 'TASK_DUE',
      v_row.n || ' prospect' || case when v_row.n = 1 then '' else 's' end || ' with no next step in ' || v_row.name,
      'Worked, but no follow-up is planned. Add a task or move them on.',
      '/prospects/campaigns/' || v_row.id,
      null, null, 'prospect-no-next:' || v_row.id || ':' || v_today);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function prospect_reminders() from public, anon, authenticated;

-- 08:05 in Pakistan, just after the CRM's own due-work reminders.
select cron.unschedule('babultech-prospect-reminders') where exists (select 1 from cron.job where jobname = 'babultech-prospect-reminders');
select cron.schedule('babultech-prospect-reminders', '5 3 * * *', 'select public.prospect_reminders()');

notify pgrst, 'reload schema';
