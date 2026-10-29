-- The Company overview: the whole business on one screen, for the Super Admin
-- and CRM Admins, and the same figures in the Monday summary email.
--
-- company_overview(from, to) returns, for that period and the one before it:
-- headline figures, the funnel from prospect to payment, sales, delivery,
-- money, a per-person scoreboard and what needs a decision. Money is in the
-- base currency (each amount times its currency's exchange rate). Dates are
-- Pakistan time.
--
-- Security definer, because it reads across every module; it refuses anyone
-- signed in without administrator permission. The weekly email calls it with
-- no user (pg_cron), which is allowed.

create or replace function company_overview(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_days integer := greatest(1, p_to - p_from + 1);
  v_pfrom date := p_from - v_days;
  v_pto date := p_from - 1;
  v_week date := v_today - (extract(isodow from v_today)::int - 1);
  v_result jsonb;
begin
  if auth.uid() is not null and not app_has_permission('admin:*') then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  with
  rate as (select code, coalesce("exchangeRate", 1) r from currency),
  headline as (
    select f, t, jsonb_build_object(
      'prospectsAdded', (select count(*) from prospect where "deletedAt" is null and ("createdAt" at time zone 'Asia/Karachi')::date between f and t),
      'prospectsQualified', (select count(*) from prospect where status = 'QUALIFIED' and ("qualifiedAt" at time zone 'Asia/Karachi')::date between f and t),
      'outreachTouches', (select count(*) from prospect_activity where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL') and ("occurredAt" at time zone 'Asia/Karachi')::date between f and t),
      'leadsCreated', (select count(*) from lead where "deletedAt" is null and status <> 'PROSPECT' and ("createdAt" at time zone 'Asia/Karachi')::date between f and t),
      'dealsCreated', (select count(*) from opportunity where "deletedAt" is null and ("createdAt" at time zone 'Asia/Karachi')::date between f and t),
      'dealsWon', (select count(*) from opportunity where "deletedAt" is null and stage = 'CLOSED_WON' and "actualCloseDate" between f and t),
      'dealsWonValue', (select coalesce(sum(o.amount * coalesce(rate.r, 1)), 0) from opportunity o left join rate on rate.code = o."currencyCode" where o."deletedAt" is null and o.stage = 'CLOSED_WON' and o."actualCloseDate" between f and t),
      'dealsLost', (select count(*) from opportunity where "deletedAt" is null and stage = 'CLOSED_LOST' and "actualCloseDate" between f and t),
      'invoiced', (select coalesce(sum(i."totalAmount" * coalesce(rate.r, 1)), 0) from invoice i left join rate on rate.code = i."currencyCode" where i."deletedAt" is null and i.status not in ('DRAFT', 'CANCELLED') and i."invoiceDate" between f and t),
      'collected', (select coalesce(sum(p.amount * coalesce(rate.r, 1)), 0) from payment p left join rate on rate.code = p."currencyCode" where p."deletedAt" is null and p.status in ('PENDING', 'CLEARED') and p."paymentDate" between f and t),
      'expenses', (select coalesce(sum(e.amount * coalesce(rate.r, 1)), 0) from expense e left join rate on rate.code = e."currencyCode" where e."deletedAt" is null and e."approvalStatus" <> 'REJECTED' and e."expenseDate" between f and t),
      'hoursLogged', (select coalesce(sum(hours), 0) from time_log where "approvalStatus"::text <> 'REJECTED' and "workDate" between f and t)
    ) v
    from (values (p_from, p_to), (v_pfrom, v_pto)) as periods(f, t)
  ),
  open_deals as (
    select o.*, o.amount * coalesce(rate.r, 1) as base
    from opportunity o left join rate on rate.code = o."currencyCode"
    where o."deletedAt" is null and o.stage not in ('CLOSED_WON', 'CLOSED_LOST')
  ),
  overdue as (
    select i.*, i."outstandingAmount" * coalesce(rate.r, 1) as base, v_today - i."dueDate" as late
    from invoice i left join rate on rate.code = i."currencyCode"
    where i."deletedAt" is null and i.status not in ('DRAFT', 'CANCELLED', 'PAID', 'WRITTEN_OFF') and i."outstandingAmount" > 0
  ),
  active_projects as (
    select p.id, p.name, p."projectNumber", p.health, p.status, p."approvedHours", p."completionPercent",
      (select coalesce(sum(t.hours), 0) from time_log t where t."projectId" = p.id and t."approvalStatus"::text <> 'REJECTED') logged,
      (select count(*) from project_task k where k."projectId" = p.id and k.status not in ('COMPLETED', 'CANCELLED') and k."dueDate" < v_today) overdue_tasks,
      (select coalesce(sum(t.hours * coalesce(t."billingRate", 0)) filter (where t.billable), 0) - coalesce(sum(t.hours * coalesce(t."costRate", 0)), 0) from time_log t where t."projectId" = p.id and t."approvalStatus"::text <> 'REJECTED') margin
    from project p
    where p."deletedAt" is null and p.status in ('PLANNING', 'ACTIVE', 'ON_HOLD', 'AT_RISK')
  ),
  people as (
    select u.id, u."fullName" as name,
      (select count(*) from prospect_activity a where a."actorId" = u.id and a.type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL') and (a."occurredAt" at time zone 'Asia/Karachi')::date between p_from and p_to) touches,
      (select count(*) from prospect q where q."qualifiedById" = u.id and (q."qualifiedAt" at time zone 'Asia/Karachi')::date between p_from and p_to) qualified,
      (select count(*) from opportunity o where o."ownerUserId" = u.id and o.stage = 'CLOSED_WON' and o."actualCloseDate" between p_from and p_to and o."deletedAt" is null) won,
      (select coalesce(sum(t.hours), 0) from time_log t where t."userId" = u.id and t."workDate" between p_from and p_to and t."approvalStatus"::text <> 'REJECTED') hours,
      (select coalesce(sum(t.hours), 0) from time_log t where t."userId" = u.id and t."workDate" >= v_week and t."approvalStatus"::text <> 'REJECTED') week_hours
    from app_user u
    where u.status = 'ACTIVE' and u."deletedAt" is null and u."partnerId" is null
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'previousFrom', v_pfrom, 'previousTo', v_pto, 'today', v_today),
    'current', (select v from headline where f = p_from),
    'previous', (select v from headline where f = v_pfrom),
    'funnel', jsonb_build_object(
      'prospectsAdded', (select count(*) from prospect where "deletedAt" is null and ("createdAt" at time zone 'Asia/Karachi')::date between p_from and p_to),
      'prospectsWorked', (select count(distinct "prospectId") from prospect_activity where type in ('EMAIL_SENT', 'FOLLOWUP_SENT', 'CALL_ATTEMPTED', 'CALL_CONNECTED', 'VOICEMAIL') and ("occurredAt" at time zone 'Asia/Karachi')::date between p_from and p_to),
      'qualified', (select count(*) from prospect where status = 'QUALIFIED' and ("qualifiedAt" at time zone 'Asia/Karachi')::date between p_from and p_to),
      'leads', (select count(*) from lead where "deletedAt" is null and status <> 'PROSPECT' and ("createdAt" at time zone 'Asia/Karachi')::date between p_from and p_to),
      'deals', (select count(*) from opportunity where "deletedAt" is null and ("createdAt" at time zone 'Asia/Karachi')::date between p_from and p_to),
      'won', (select count(*) from opportunity where "deletedAt" is null and stage = 'CLOSED_WON' and "actualCloseDate" between p_from and p_to),
      'invoiced', (select count(*) from invoice where "deletedAt" is null and status not in ('DRAFT', 'CANCELLED') and "invoiceDate" between p_from and p_to),
      'paid', (select count(*) from invoice where "deletedAt" is null and status = 'PAID' and "invoiceDate" between p_from and p_to)
    ),
    'sales', jsonb_build_object(
      'pipelineValue', (select coalesce(sum(base), 0) from open_deals),
      'openDeals', (select count(*) from open_deals),
      'byStage', coalesce((select jsonb_agg(jsonb_build_object('stage', stage, 'count', n, 'value', v) order by min_order) from (select stage::text, count(*) n, coalesce(sum(base), 0) v, min(array_position(enum_range(null::"OpportunityStage"), stage)) min_order from open_deals group by stage) s), '[]'::jsonb),
      'closingThisMonth', (select count(*) from open_deals where date_trunc('month', "expectedCloseDate") = date_trunc('month', v_today::timestamp)),
      'closingThisMonthValue', (select coalesce(sum(base), 0) from open_deals where date_trunc('month', "expectedCloseDate") = date_trunc('month', v_today::timestamp)),
      'pastCloseDate', (select count(*) from open_deals where "expectedCloseDate" < v_today),
      'topDeals', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'stage', stage, 'value', base, 'closeDate', "expectedCloseDate") order by base desc nulls last) from (select * from open_deals order by base desc nulls last limit 5) d), '[]'::jsonb)
    ),
    'delivery', jsonb_build_object(
      'activeProjects', (select count(*) from active_projects),
      'byHealth', jsonb_build_object('GREEN', (select count(*) from active_projects where health = 'GREEN'), 'AMBER', (select count(*) from active_projects where health = 'AMBER'), 'RED', (select count(*) from active_projects where health = 'RED')),
      'overdueTasks', (select coalesce(sum(overdue_tasks), 0) from active_projects),
      'projects', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'number', "projectNumber", 'health', health, 'status', status, 'approvedHours', "approvedHours", 'logged', logged, 'completion', "completionPercent", 'overdueTasks', overdue_tasks, 'margin', margin)
        order by case health when 'RED' then 0 when 'AMBER' then 1 else 2 end, overdue_tasks desc) from active_projects), '[]'::jsonb),
      'workload', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'weekHours', week_hours) order by week_hours desc) from people where week_hours > 0), '[]'::jsonb)
    ),
    'money', jsonb_build_object(
      'outstanding', (select coalesce(sum(base), 0) from overdue),
      'overdueCount', (select count(*) from overdue where late > 0),
      'overdueValue', (select coalesce(sum(base), 0) from overdue where late > 0),
      'aging', jsonb_build_object(
        'current', (select coalesce(sum(base), 0) from overdue where late <= 0),
        'd1_30', (select coalesce(sum(base), 0) from overdue where late between 1 and 30),
        'd31_60', (select coalesce(sum(base), 0) from overdue where late between 31 and 60),
        'd61', (select coalesce(sum(base), 0) from overdue where late > 60))
    ),
    'team', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'touches', touches, 'qualified', qualified, 'won', won, 'hours', hours) order by touches + qualified * 10 + won * 20 + hours desc)
      from people where touches + qualified + won + hours > 0), '[]'::jsonb),
    'attention', jsonb_build_object(
      'approvals', (select count(*) from approval_request where status = 'PENDING'),
      'casesBreached', (select count(*) from support_case where "deletedAt" is null and status not in ('RESOLVED', 'CLOSED', 'CANCELLED') and (coalesce("slaBreached", false) or "resolutionDueAt" < now())),
      'contractsExpiring', (select count(*) from contract where "deletedAt" is null and status = 'ACTIVE' and "endDate" between v_today and v_today + 60),
      'staleLeads', (select count(*) from lead where "deletedAt" is null and status in ('NEW', 'ASSIGNED', 'ATTEMPTED_CONTACT', 'CONTACTED', 'NURTURING') and "updatedAt" < now() - interval '7 days'),
      'overdueInvoices', (select count(*) from overdue where late > 0),
      'dealsPastClose', (select count(*) from open_deals where "expectedCloseDate" < v_today)
    )
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function company_overview(date, date) from public, anon;
grant execute on function company_overview(date, date) to authenticated;

notify pgrst, 'reload schema';
