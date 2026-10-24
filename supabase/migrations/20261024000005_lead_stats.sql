-- True figures for the leads page.
--
-- The page used to count the rows it had loaded, which stop at 500, so with
-- thousands of leads every tile undercounted. This counts in the database,
-- with the same filters as the list, and runs as the caller so row-level
-- security limits it to the leads they can see.

create or replace function lead_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with f as (
    select
      nullif(p_filters->>'status', '') as status,
      nullif(p_filters->>'source', '') as source,
      nullif(p_filters->>'campaignId', '')::uuid as campaign_id,
      nullif(p_filters->>'partnerId', '')::uuid as partner_id,
      nullif(p_filters->>'icpTier', '') as icp_tier,
      nullif(p_filters->>'region', '') as region,
      nullif(p_filters->>'leadList', '') as lead_list,
      nullif(regexp_replace(coalesce(p_filters->>'search', ''), '[,()]', '', 'g'), '') as search
  ),
  base as (
    select l.*
    from lead l, f
    where l."deletedAt" is null
      and (f.source is distinct from 'partner' or l."referredByPartnerId" is not null)
      and (f.campaign_id is null or l."campaignId" = f.campaign_id)
      and (f.partner_id is null or l."referredByPartnerId" = f.partner_id)
      and (f.icp_tier is null or l."icpTier" = f.icp_tier)
      and (f.region is null or l.region = f.region)
      and (f.lead_list is null or l."leadList" = f.lead_list)
      and (f.search is null or l."firstName" ilike '%' || f.search || '%' or l."lastName" ilike '%' || f.search || '%'
           or l."companyName" ilike '%' || f.search || '%' or l."leadNumber" ilike '%' || f.search || '%'
           or l.phone ilike '%' || f.search || '%')
  ),
  -- The list: one status, or everything but marketing's prospects.
  listed as (
    select b.* from base b, f
    where (f.status is not null and b.status::text = f.status) or (f.status is null and b.status <> 'PROSPECT')
  ),
  grouped as (
    select 'status' as dim, status::text as value, count(*) as n from listed group by 2
    union all select 'icpTier', "icpTier", count(*) from listed group by 2
    union all select 'region', region, count(*) from listed group by 2
    union all select 'leadList', "leadList", count(*) from listed group by 2
  )
  select jsonb_build_object(
    'total', (select count(*) from listed),
    'open', (select count(*) from listed where status not in ('CONVERTED', 'DISQUALIFIED')),
    'converted', (select count(*) from listed where status = 'CONVERTED'),
    'disqualified', (select count(*) from listed where status = 'DISQUALIFIED'),
    'estimatedValue', (select coalesce(sum("estimatedValue"), 0) from listed where status not in ('CONVERTED', 'DISQUALIFIED')),
    'partnerRegistrations', (select count(*) from listed where "referredByPartnerId" is not null),
    'awaitingReview', (select count(*) from listed where "referredByPartnerId" is not null and status = 'NEW'),
    'prospects', (select count(*) from base where status = 'PROSPECT'),
    'breakdown', coalesce((
      select jsonb_object_agg(dim, items) from (
        select dim, jsonb_agg(jsonb_build_object('value', value, 'count', n) order by n desc) as items
        from grouped group by dim
      ) d
    ), '{}'::jsonb)
  );
$$;

revoke all on function lead_stats(jsonb) from public, anon;
grant execute on function lead_stats(jsonb) to authenticated;

notify pgrst, 'reload schema';
