-- The dashboard's module counts in one round trip.
--
-- getModuleSummary() in src/server/dashboard.ts sent twenty-six queries at once
-- for these figures. Each is cheap, but together they queue for the database's
-- connection pool and held the dashboard - and so every sign-in - at around
-- 800ms. This computes the same figures in one statement.
--
-- SECURITY INVOKER, so row security applies exactly as it did to the separate
-- queries: an OWN-scope rep's open deals are still their own. The section flags
-- come from the caller's permissions, checked in the app; a section that is off
-- returns zeros without reading its tables. The dates are passed in rather than
-- read from now() so the figures agree with the app's own idea of "today".
--
-- The filters mirror the PostgREST queries they replace one for one. If either
-- side changes, change the other.

create or replace function app_dashboard_summary(
  p_see_sales boolean,
  p_see_projects boolean,
  p_see_finance boolean,
  p_see_cases boolean,
  p_see_partners boolean,
  p_month_start date,
  p_today date,
  p_soon date,
  p_agreement_horizon date
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'sales', jsonb_build_object(
      'openDeals', case when p_see_sales then (
        select count(*) from opportunity
        where "deletedAt" is null and stage not in ('CLOSED_WON', 'CLOSED_LOST')) else 0 end,
      'openValue', case when p_see_sales then (
        select coalesce(sum(amount), 0) from opportunity
        where "deletedAt" is null and stage not in ('CLOSED_WON', 'CLOSED_LOST')) else 0 end,
      'wonThisMonth', case when p_see_sales then (
        select count(*) from opportunity
        where "deletedAt" is null and stage = 'CLOSED_WON' and "actualCloseDate" >= p_month_start) else 0 end,
      'wonValueThisMonth', case when p_see_sales then (
        select coalesce(sum(amount), 0) from opportunity
        where "deletedAt" is null and stage = 'CLOSED_WON' and "actualCloseDate" >= p_month_start) else 0 end,
      'newLeads', (
        select count(*) from lead
        where "deletedAt" is null and status in ('NEW', 'ASSIGNED')),
      'leadsToFollowUp', (
        select count(*) from lead
        where "deletedAt" is null and "convertedAt" is null and "nextFollowUpAt" <= now()),
      'quotesAwaitingReply', case when p_see_sales then (
        select count(*) from quotation where "deletedAt" is null and status = 'SENT') else 0 end,
      'quoteValueOut', case when p_see_sales then (
        select coalesce(sum("totalAmount"), 0) from quotation
        where "deletedAt" is null and status = 'SENT') else 0 end
    ),
    'delivery', jsonb_build_object(
      'activeProjects', case when p_see_projects then (
        select count(*) from project
        where "deletedAt" is null and status in ('ACTIVE', 'PLANNING')) else 0 end,
      'atRiskProjects', case when p_see_projects then (
        select count(*) from project
        where "deletedAt" is null and (status = 'AT_RISK' or health = 'RED')) else 0 end,
      'milestonesDueSoon', case when p_see_projects then (
        select count(*) from milestone
        where status <> 'COMPLETED' and "dueDate" <= p_soon) else 0 end,
      'overdueTasks', case when p_see_projects then (
        select count(*) from project_task
        where status not in ('COMPLETED', 'CANCELLED') and "dueDate" < p_today) else 0 end,
      'hoursAwaitingApproval', case when p_see_projects then (
        select coalesce(sum(hours), 0) from time_log where "approvalStatus" = 'SUBMITTED') else 0 end
    ),
    'finance', jsonb_build_object(
      'outstanding', case when p_see_finance then (
        select coalesce(sum("outstandingAmount"), 0) from invoice
        where "deletedAt" is null and status not in ('PAID', 'CANCELLED', 'WRITTEN_OFF', 'DRAFT')) else 0 end,
      'overdue', case when p_see_finance then (
        select coalesce(sum("outstandingAmount"), 0) from invoice
        where "deletedAt" is null and status not in ('PAID', 'CANCELLED', 'WRITTEN_OFF', 'DRAFT')
          and "dueDate" < p_today) else 0 end,
      'overdueCount', case when p_see_finance then (
        select count(*) from invoice
        where "deletedAt" is null and status not in ('PAID', 'CANCELLED', 'WRITTEN_OFF', 'DRAFT')
          and "dueDate" < p_today) else 0 end,
      'collectedThisMonth', case when p_see_finance then (
        select coalesce(sum(amount), 0) from payment
        where "deletedAt" is null and status = 'CLEARED' and "paymentDate" >= p_month_start) else 0 end,
      'unallocatedPayments', case when p_see_finance then (
        select coalesce(sum("unallocatedAmount"), 0) from payment
        where "deletedAt" is null and "unallocatedAmount" > 0) else 0 end,
      'draftInvoices', case when p_see_finance then (
        select count(*) from invoice where "deletedAt" is null and status = 'DRAFT') else 0 end
    ),
    'service', jsonb_build_object(
      'openCases', case when p_see_cases then (
        select count(*) from support_case
        where "deletedAt" is null and status not in ('CLOSED', 'CANCELLED', 'RESOLVED')) else 0 end,
      'criticalCases', case when p_see_cases then (
        select count(*) from support_case
        where "deletedAt" is null and status not in ('CLOSED', 'CANCELLED', 'RESOLVED')
          and priority = 'CRITICAL') else 0 end,
      'breachedSla', case when p_see_cases then (
        select count(*) from support_case
        where "deletedAt" is null and "slaBreached" = true
          and status not in ('CLOSED', 'CANCELLED', 'RESOLVED')) else 0 end,
      'unassignedCases', case when p_see_cases then (
        select count(*) from support_case
        where "deletedAt" is null and status not in ('CLOSED', 'CANCELLED', 'RESOLVED')
          and "ownerUserId" is null and "teamId" is null) else 0 end
    ),
    'partners', jsonb_build_object(
      'activePartners', case when p_see_partners then (
        select count(*) from partner where "deletedAt" is null and status = 'ACTIVE') else 0 end,
      -- Owed to partners: in progress on deals already won. An inner join, as
      -- the !inner embed was, so a deal the reader cannot see adds nothing.
      'commissionPayable', case when p_see_partners then (
        select coalesce(sum(c."partnerAmount"), 0)
        from partner_commission c
        join opportunity o on o.id = c."opportunityId"
        where c.status = 'IN_PROGRESS' and o.stage = 'CLOSED_WON') else 0 end,
      'commissionPendingApproval', case when p_see_partners then (
        select count(*) from partner_commission where "requestStatus" = 'PENDING') else 0 end,
      'agreementsExpiringSoon', case when p_see_partners then (
        select count(*) from partner
        where "deletedAt" is null and status = 'ACTIVE'
          and "agreementExpiryDate" is not null and "agreementExpiryDate" <= p_agreement_horizon) else 0 end
    )
  );
$$;

revoke all on function app_dashboard_summary(boolean, boolean, boolean, boolean, boolean, date, date, date, date) from public, anon;
grant execute on function app_dashboard_summary(boolean, boolean, boolean, boolean, boolean, date, date, date, date) to authenticated;
