-- The extra panels on the merged Company overview: the 30-day cash outlook,
-- six months of trends, system health and last week's timesheets. Money is in
-- the base currency, converted the same way as company_overview().

create or replace function company_overview_extras()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_end date := v_today + 30;
  v_week date := v_today - (extract(isodow from v_today)::int - 1);
  v_last date := v_week - 7;
  v_first date := (date_trunc('month', v_today) - interval '5 months')::date;
begin
  if auth.uid() is not null and not app_has_permission('admin:*') then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  return (
    with rate as (select code, coalesce("exchangeRate", 1) r from currency)
    select jsonb_build_object(
      'cash', jsonb_build_object(
        'overdueIn', (select coalesce(sum(i."outstandingAmount" * coalesce(x.r, 1)), 0) from invoice i left join rate x on x.code = i."currencyCode"
          where i."deletedAt" is null and i.status::text not in ('DRAFT', 'CANCELLED', 'PAID', 'WRITTEN_OFF') and i."outstandingAmount" > 0 and i."dueDate" < v_today),
        'dueIn', (select coalesce(sum(i."outstandingAmount" * coalesce(x.r, 1)), 0) from invoice i left join rate x on x.code = i."currencyCode"
          where i."deletedAt" is null and i.status::text not in ('DRAFT', 'CANCELLED', 'PAID', 'WRITTEN_OFF') and i."outstandingAmount" > 0 and i."dueDate" between v_today and v_end),
        'bills', (select coalesce(sum(b."outstandingAmount" * coalesce(x.r, 1)), 0) from vendor_bill b left join rate x on x.code = b."currencyCode"
          where b."deletedAt" is null and b.status::text in ('APPROVED', 'PARTIALLY_PAID', 'OVERDUE') and b."outstandingAmount" > 0 and b."dueDate" <= v_end),
        'commissions', (select coalesce(sum(c."partnerAmount" * coalesce(x.r, 1)), 0) from partner_commission c left join rate x on x.code = c."currencyCode"
          where c."paymentDate" is null and c.status not in ('PAID', 'CLOSED', 'CANCELLED', 'REJECTED', 'DRAFT')),
        'expenses', (select coalesce(sum(e.amount * coalesce(x.r, 1)), 0) from expense e left join rate x on x.code = e."currencyCode"
          where e."deletedAt" is null and e."approvalStatus"::text = 'APPROVED' and e."paymentStatus"::text = 'UNPAID')
      ),
      'trends', (select jsonb_agg(jsonb_build_object(
          'month', to_char(m, 'Mon YY'),
          'invoiced', (select coalesce(sum(i."totalAmount" * coalesce(x.r, 1)), 0) from invoice i left join rate x on x.code = i."currencyCode"
            where i."deletedAt" is null and i.status::text not in ('DRAFT', 'CANCELLED') and date_trunc('month', i."invoiceDate") = m),
          'collected', (select coalesce(sum(p.amount * coalesce(x.r, 1)), 0) from payment p left join rate x on x.code = p."currencyCode"
            where p."deletedAt" is null and p.status::text in ('PENDING', 'CLEARED') and date_trunc('month', p."paymentDate") = m),
          'newPipeline', (select coalesce(sum(o.amount * coalesce(x.r, 1)), 0) from opportunity o left join rate x on x.code = o."currencyCode"
            where o."deletedAt" is null and date_trunc('month', o."createdAt" at time zone 'Asia/Karachi') = m)
        ) order by m) from generate_series(v_first::timestamp, date_trunc('month', v_today::timestamp), interval '1 month') m),
      'health', jsonb_build_object(
        'lastEmailOutcome', (select outcome from activity_event where category = 'EMAIL' and outcome <> 'SKIPPED' order by "occurredAt" desc limit 1),
        'emailFailed7d', (select count(*) from activity_event where category = 'EMAIL' and outcome = 'FAILED' and "occurredAt" > now() - interval '7 days'),
        'jobsFailed7d', (select count(*) from job where status = 'FAILED' and "finishedAt" > now() - interval '7 days'),
        'signInsFailed7d', (select count(*) from login_event where "eventType" ilike '%FAILED%' and "createdAt" > now() - interval '7 days')
      ),
      'timesheets', jsonb_build_object(
        'weekStart', v_last,
        'people', coalesce((select jsonb_agg(jsonb_build_object(
            'id', p."userId", 'name', p."fullName", 'committed', p.committed,
            'logged', (select coalesce(sum(hours), 0) from time_log t where t."userId" = p."userId" and t."workDate" >= v_last and t."workDate" < v_week),
            'status', (select w.status from weekly_timesheet w where w."userId" = p."userId" and w."weekStart" = v_last)
          ) order by p."fullName") from timesheet_people() p), '[]'::jsonb)
      )
    )
  );
end $$;
revoke all on function company_overview_extras() from public, anon;
grant execute on function company_overview_extras() to authenticated, service_role;

notify pgrst, 'reload schema';
