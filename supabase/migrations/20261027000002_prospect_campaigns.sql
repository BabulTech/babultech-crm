-- Prospecting, phase 2: outreach campaigns, from ORMS.
--
--   prospect_campaign          an outreach campaign: default channel, follow-up days
--   prospect_campaign_member   its team (manager / member / viewer); none = open to all
--   prospect_campaign_entry    a prospect in a campaign, with its own status and touches
--   prospect_activity          outreach logged on a prospect: calls, emails, meetings, notes
--   prospect_task              follow-ups and reminders, assignable
--
-- Access: prospect:read / prospect:write as in phase 1, narrowed by campaign
-- team where a campaign has one. The campaigns a user may see or work are
-- worked out once per query (prospect_visible_campaigns), never per row, so
-- the tables can hold hundreds of thousands of rows.

create table if not exists prospect_campaign (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  description text,
  status varchar(20) not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'COMPLETED')),
  -- Null: choose a channel per touch. A value fixes every touch to it.
  "defaultChannel" varchar(30) check ("defaultChannel" is null or "defaultChannel" in (
    'business_email', 'business_phone', 'personal_email', 'personal_phone', 'whatsapp', 'linkedin', 'contact_form', 'in_person', 'other')),
  "followupDays" integer not null default 3 check ("followupDays" between 1 and 60),
  "ownerUserId" uuid references app_user(id) on delete set null,
  "startDate" date,
  "endDate" date,
  "createdById" uuid references app_user(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "deletedAt" timestamptz
);

create table if not exists prospect_campaign_member (
  "campaignId" uuid not null references prospect_campaign(id) on delete cascade,
  "userId" uuid not null references app_user(id) on delete cascade,
  role varchar(10) not null check (role in ('manager', 'member', 'viewer')),
  "createdAt" timestamptz not null default now(),
  primary key ("campaignId", "userId")
);
create index if not exists prospect_campaign_member_user_idx on prospect_campaign_member ("userId");

create table if not exists prospect_campaign_entry (
  id uuid primary key default gen_random_uuid(),
  "campaignId" uuid not null references prospect_campaign(id) on delete cascade,
  "prospectId" uuid not null references prospect(id) on delete cascade,
  status varchar(30) not null default 'new' check (status in (
    'new', 'contacted', 'following_up', 'replied', 'interested_meeting', 'won', 'lost', 'no_fit')),
  "touchCount" integer not null default 0 check ("touchCount" >= 0),
  "lastContactedAt" timestamptz,
  "assignedUserId" uuid references app_user(id) on delete set null,
  "addedById" uuid references app_user(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("campaignId", "prospectId")
);
create index if not exists prospect_campaign_entry_list_idx on prospect_campaign_entry ("campaignId", status, "createdAt" desc);
create index if not exists prospect_campaign_entry_prospect_idx on prospect_campaign_entry ("prospectId");

create table if not exists prospect_activity (
  id uuid primary key default gen_random_uuid(),
  "prospectId" uuid not null references prospect(id) on delete cascade,
  "campaignId" uuid references prospect_campaign(id) on delete set null,
  type varchar(30) not null check (type in (
    'EMAIL_SENT', 'FOLLOWUP_SENT', 'EMAIL_REPLY', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL',
    'MEETING_BOOKED', 'MEETING_COMPLETED', 'NOTE_ADDED', 'STATUS_CHANGED', 'INFO_UPDATED')),
  channel varchar(30),
  "personId" uuid references prospect_person(id) on delete set null,
  content text,
  "occurredAt" timestamptz not null default now(),
  "actorId" uuid references app_user(id) on delete set null,
  "createdAt" timestamptz not null default now()
);
create index if not exists prospect_activity_prospect_idx on prospect_activity ("prospectId", "occurredAt" desc);
create index if not exists prospect_activity_campaign_idx on prospect_activity ("campaignId", "occurredAt" desc);
create index if not exists prospect_activity_actor_idx on prospect_activity ("actorId", "occurredAt" desc);

create table if not exists prospect_task (
  id uuid primary key default gen_random_uuid(),
  "prospectId" uuid references prospect(id) on delete cascade,
  "campaignId" uuid references prospect_campaign(id) on delete set null,
  type varchar(30) not null default 'general_reminder' check (type in ('followup_email', 'call_lead', 'meeting_reminder', 'general_reminder')),
  title varchar(300) not null,
  "dueDate" date not null,
  priority varchar(10) not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status varchar(10) not null default 'open' check (status in ('open', 'done')),
  "assignedTo" uuid references app_user(id) on delete set null,
  "createdById" uuid references app_user(id) on delete set null,
  "completedById" uuid references app_user(id) on delete set null,
  "completedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists prospect_task_due_idx on prospect_task (status, "dueDate");
create index if not exists prospect_task_assignee_idx on prospect_task ("assignedTo", status, "dueDate");
create index if not exists prospect_task_prospect_idx on prospect_task ("prospectId");

-- Which campaigns the caller may see (p_write false) or work (p_write true):
-- every campaign with no team; their own; ones they are on the team of
-- (viewers can only see); and every campaign for administrators.
create or replace function prospect_visible_campaigns(p_write boolean default false)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id from prospect_campaign c
  where c."deletedAt" is null
    and (
      app_has_permission('admin:*')
      or c."ownerUserId" = app_current_user_id()
      or not exists (select 1 from prospect_campaign_member m where m."campaignId" = c.id)
      or exists (select 1 from prospect_campaign_member m where m."campaignId" = c.id and m."userId" = app_current_user_id()
                 and (not p_write or m.role in ('manager', 'member')))
    );
$$;
revoke all on function prospect_visible_campaigns(boolean) from public, anon;
grant execute on function prospect_visible_campaigns(boolean) to authenticated;

-- Who may change a campaign's settings and team: its owner, its managers,
-- administrators.
create or replace function prospect_campaign_managed(p_campaign uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_has_permission('admin:*')
    or exists (select 1 from prospect_campaign c where c.id = p_campaign and c."ownerUserId" = app_current_user_id())
    or exists (select 1 from prospect_campaign_member m where m."campaignId" = p_campaign and m."userId" = app_current_user_id() and m.role = 'manager');
$$;
revoke all on function prospect_campaign_managed(uuid) from public, anon;
grant execute on function prospect_campaign_managed(uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['prospect_campaign', 'prospect_campaign_member', 'prospect_campaign_entry', 'prospect_activity', 'prospect_task'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
  end loop;
end $$;

-- Campaigns: anyone with prospect access sees the campaigns open to them;
-- anyone who works prospects can create one; owners and managers change it.
create policy prospect_campaign_read on prospect_campaign for select to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:read') or app_has_permission('prospect:write'))
         and id in (select prospect_visible_campaigns(false)));
create policy prospect_campaign_write on prospect_campaign for all to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:write')) and prospect_campaign_managed(id))
  with check ((select app_is_internal()) and (select app_has_permission('prospect:write'))
              and ("ownerUserId" = (select app_current_user_id()) or prospect_campaign_managed(id)));

create policy prospect_campaign_member_read on prospect_campaign_member for select to authenticated
  using ((select app_is_internal()) and "campaignId" in (select prospect_visible_campaigns(false)));
create policy prospect_campaign_member_write on prospect_campaign_member for all to authenticated
  using ((select app_has_permission('prospect:write')) and prospect_campaign_managed("campaignId"))
  with check ((select app_has_permission('prospect:write')) and prospect_campaign_managed("campaignId"));

create policy prospect_campaign_entry_read on prospect_campaign_entry for select to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:read') or app_has_permission('prospect:write'))
         and "campaignId" in (select prospect_visible_campaigns(false)));
create policy prospect_campaign_entry_write on prospect_campaign_entry for all to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:write')) and "campaignId" in (select prospect_visible_campaigns(true)))
  with check ((select app_is_internal()) and (select app_has_permission('prospect:write')) and "campaignId" in (select prospect_visible_campaigns(true)));

-- Activities and tasks: those in a campaign follow the campaign; those
-- outside any campaign follow the prospect permissions alone.
create policy prospect_activity_read on prospect_activity for select to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:read') or app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(false))));
create policy prospect_activity_write on prospect_activity for all to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(true))))
  with check ((select app_is_internal()) and (select app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(true))));

create policy prospect_task_read on prospect_task for select to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:read') or app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(false))));
create policy prospect_task_write on prospect_task for all to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(true))))
  with check ((select app_is_internal()) and (select app_has_permission('prospect:write'))
         and ("campaignId" is null or "campaignId" in (select prospect_visible_campaigns(true))));

-- Counts by status for one campaign, as the caller.
create or replace function prospect_campaign_stats(p_campaign uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total', count(*),
    'byStatus', coalesce(jsonb_object_agg(status, n) filter (where status is not null), '{}'::jsonb),
    'touched', coalesce(sum(n) filter (where status <> 'new'), 0)
  )
  from (select status, count(*) n from prospect_campaign_entry where "campaignId" = p_campaign group by status) s;
$$;
revoke all on function prospect_campaign_stats(uuid) from public, anon;
grant execute on function prospect_campaign_stats(uuid) to authenticated;

-- Adds every prospect matching a prospects-list filter to a campaign in one
-- statement, so "add all 40,000 in this region" does not travel through the
-- browser. Existing entries keep their progress.
create or replace function prospect_campaign_add_filtered(p_campaign uuid, p_filters jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare added integer;
begin
  insert into prospect_campaign_entry ("campaignId", "prospectId", "addedById")
  select p_campaign, p.id, app_current_user_id() from prospect_filtered(p_filters) p
  on conflict ("campaignId", "prospectId") do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;
revoke all on function prospect_campaign_add_filtered(uuid, jsonb) from public, anon;
grant execute on function prospect_campaign_add_filtered(uuid, jsonb) to authenticated;

-- One touch, counted atomically: two people logging at once both count.
create or replace function prospect_campaign_touch(p_campaign uuid, p_prospect uuid, p_at timestamptz)
returns void
language sql
security invoker
set search_path = public
as $$
  update prospect_campaign_entry
     set "touchCount" = "touchCount" + 1,
         "lastContactedAt" = greatest(coalesce("lastContactedAt", p_at), p_at),
         "updatedAt" = now()
   where "campaignId" = p_campaign and "prospectId" = p_prospect;
$$;
revoke all on function prospect_campaign_touch(uuid, uuid, timestamptz) from public, anon;
grant execute on function prospect_campaign_touch(uuid, uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
