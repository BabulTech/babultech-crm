-- One definition of "the prospects this filter means", shared by the list
-- page and its figures, so the count above the table always matches the
-- table. Runs as the caller: row-level security applies.

create or replace function prospect_filtered(p_filters jsonb default '{}'::jsonb)
returns setof prospect
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with f as (
    select
      nullif(p_filters->>'datasetId', '')::uuid as dataset_id,
      nullif(p_filters->>'status', '') as status,
      nullif(p_filters->>'icpTier', '') as icp_tier,
      nullif(p_filters->>'region', '') as region,
      nullif(p_filters->>'tag', '') as tag,
      nullif(trim(coalesce(p_filters->>'search', '')), '') as search,
      nullif(regexp_replace(coalesce(p_filters->>'search', ''), '\D', '', 'g'), '') as digits
  )
  select p.* from prospect p, f
  where p."deletedAt" is null
    and (f.dataset_id is null or p."datasetId" = f.dataset_id)
    and (case when f.status is null then p.status = 'ACTIVE' else p.status = f.status end)
    and (f.icp_tier is null or p."icpTier" = f.icp_tier)
    and (f.region is null or p.region = f.region)
    and (f.tag is null or f.tag = any (p.tags))
    and (f.search is null
         or p."businessName" ilike '%' || f.search || '%'
         or p."websiteNorm" like '%' || lower(f.search) || '%'
         or (length(coalesce(f.digits, '')) >= 4 and exists (select 1 from prospect_phone ph where ph."prospectId" = p.id and ph."phoneNorm" like '%' || f.digits || '%'))
         or exists (select 1 from prospect_email em where em."prospectId" = p.id and em."emailNorm" like '%' || lower(f.search) || '%'));
$$;
revoke all on function prospect_filtered(jsonb) from public, anon;
grant execute on function prospect_filtered(jsonb) to authenticated;

-- One page of the list, newest first.
create or replace function prospect_page(p_filters jsonb default '{}'::jsonb, p_limit int default 50, p_offset int default 0)
returns setof prospect
language sql
stable
security invoker
set search_path = public
as $$
  select * from prospect_filtered(p_filters)
  order by "createdAt" desc, id
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
$$;
revoke all on function prospect_page(jsonb, int, int) from public, anon;
grant execute on function prospect_page(jsonb, int, int) to authenticated;

create or replace function prospect_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with listed as (select * from prospect_filtered(p_filters))
  select jsonb_build_object(
    'total', (select count(*) from listed),
    'byIcpTier', coalesce((select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc) from (select "icpTier" v, count(*) n from listed where "icpTier" is not null group by 1) x), '[]'::jsonb),
    'byRegion', coalesce((select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc) from (select region v, count(*) n from listed where region is not null group by 1) x), '[]'::jsonb),
    'withPhone', (select count(*) from listed l where exists (select 1 from prospect_phone ph where ph."prospectId" = l.id)),
    'withEmail', (select count(*) from listed l where exists (select 1 from prospect_email em where em."prospectId" = l.id)),
    'withWebsite', (select count(*) from listed where website is not null),
    'qualified', (select count(*) from prospect where "deletedAt" is null and status = 'QUALIFIED')
  );
$$;

notify pgrst, 'reload schema';
