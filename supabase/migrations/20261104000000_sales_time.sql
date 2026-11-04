-- Time spent on sales: a prospect, lead, deal or account, beside projects and
-- support cases. Never billable; standing rates are snapshotted as for cases.

alter table time_log add column if not exists "salesEntityType" varchar(20)
  check ("salesEntityType" in ('Prospect', 'Lead', 'Opportunity', 'Account'));
alter table time_log add column if not exists "salesEntityId" uuid;
alter table time_log add column if not exists "salesActivity" varchar(20)
  check ("salesActivity" in ('CALL', 'EMAIL', 'MEETING', 'PROPOSAL', 'RESEARCH', 'FOLLOW_UP'));
create index if not exists time_log_sales_idx on time_log ("salesEntityType", "salesEntityId") where "salesEntityId" is not null;

alter table time_log drop constraint if exists time_log_sales_paired_check;
alter table time_log add constraint time_log_sales_paired_check
  check (("salesEntityType" is null) = ("salesEntityId" is null));
alter table time_log drop constraint if exists time_log_context_check;
alter table time_log add constraint time_log_context_check
  check ("projectId" is not null or "projectTaskId" is not null or "caseId" is not null or "salesEntityId" is not null);

-- Anyone internal may log their own sales time; the record is checked by the app.
drop policy if exists time_access_insert on time_log;
create policy time_access_insert on time_log for insert with check (
  "userId" = app_current_user_id() and "approvalStatus" = 'DRAFT' and (
    app_time_context("projectId", "caseId")
    or ("projectId" is null and "caseId" is null and "salesEntityId" is not null and app_is_internal() and app_current_scope() is not null)
  )
);

-- Approvers see and decide sales time like other time with no project.
create or replace function app_time_review(p_project uuid, p_case uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app_is_internal() and app_current_scope() is not null and app_has_permission('time:approve')
  and (app_current_scope() = 'ALL' or (p_project is not null and app_project_access(p_project, true))
    or (p_project is null and p_case is not null and exists (
      select 1 from support_case c where c.id = p_case and c."ownerUserId" in (select app_visible_owner_ids())
    ))
    or (p_project is null and p_case is null));
$$;

-- What a record took, for the Time spent panels: the record itself, and for a
-- deal or account the leads and prospects that became it.
create or replace function sales_time_for(p_type text, p_id uuid)
returns table (id uuid, "workDate" date, hours numeric, description text, "salesActivity" text, "salesEntityType" text, "userName" text, "approvalStatus" text, "costRate" numeric)
language sql stable security definer set search_path = public as $$
  with leads as (
    select l.id from lead l where (p_type = 'Lead' and l.id = p_id)
      or (p_type = 'Opportunity' and l."convertedOpportunityId" = p_id)
      or (p_type = 'Account' and l."convertedAccountId" = p_id)
  ), targets as (
    select 'Lead'::text t, id from leads
    union select 'Prospect', p.id from prospect p where p."qualifiedLeadId" in (select id from leads) or (p_type = 'Prospect' and p.id = p_id)
    union select 'Opportunity', o.id from opportunity o where (p_type = 'Opportunity' and o.id = p_id) or (p_type = 'Account' and o."accountId" = p_id)
    union select 'Account', p_id where p_type = 'Account'
  )
  select t.id, t."workDate", t.hours, t.description, t."salesActivity", t."salesEntityType", u."fullName", t."approvalStatus"::text, t."costRate"
    from time_log t join targets x on x.t = t."salesEntityType" and x.id = t."salesEntityId"
    left join app_user u on u.id = t."userId"
   where app_is_internal() or auth.uid() is null
   order by t."workDate" desc, t."createdAt" desc;
$$;
revoke all on function sales_time_for(text, uuid) from public, anon;
grant execute on function sales_time_for(text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
